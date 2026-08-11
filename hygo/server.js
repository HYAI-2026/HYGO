// HY-GO 네트워킹 프로그램 — 독립 서버.
// 메인 프로젝트(server.js, Project LIFE 게임)와는 완전히 분리된 별도 앱이다.
// 실행: node hygo/server.js  (포트는 HYGO_PORT, 기본 4000)

require("dotenv").config();
const fs = require("fs");
const path = require("path");
const http = require("http");
const express = require("express");
const { Server: SocketIOServer } = require("socket.io");

const ADMIN_PASSWORD = process.env.HYGO_ADMIN_PASSWORD || "hyai0926";
const DAILY_CASUAL_CAP = 15;
const DATA_PATH = path.join(__dirname, "data", "hygo-data.json");
const DEFAULT_CAMPAIGN = { start: "2026-09-21", end: "2026-10-30" };

const MISSIONS = [
    { key: "drink", category: "일상", emoji: "🍺", label: "술 마시기", points: 10 },
    { key: "meal", category: "일상", emoji: "🍚", label: "밥 먹기", points: 5 },
    { key: "cafe", category: "일상", emoji: "☕", label: "카페 가기", points: 5 },
    { key: "karaoke", category: "일상", emoji: "🎤", label: "노래방 가기", points: 5 },
    { key: "study", category: "일상", emoji: "📚", label: "공부/코딩하기", points: 5 },
    { key: "photo", category: "일상", emoji: "📸", label: "인증샷 찍기", points: 3 },
    { key: "surprise", category: "돌발", emoji: "🎯", label: "주차별 돌발 미션", points: null },
];
const missionByKey = key => MISSIONS.find(m => m.key === key);

const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const todayKey = iso => iso.slice(0, 10);

function placeholderPhoto(emoji, seedNum) {
    const hues = [245, 265, 285, 200, 320, 165];
    const h = hues[seedNum % hues.length];
    const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='400' height='300'>
      <defs><linearGradient id='g' x1='0' y1='0' x2='1' y2='1'>
        <stop offset='0%' stop-color='hsl(${h},70%,45%)'/>
        <stop offset='100%' stop-color='hsl(${h + 40},70%,30%)'/>
      </linearGradient></defs>
      <rect width='400' height='300' fill='url(#g)'/>
      <text x='50%' y='54%' font-size='90' text-anchor='middle' dominant-baseline='middle'>${emoji}</text>
    </svg>`;
    return "data:image/svg+xml;utf8," + encodeURIComponent(svg);
}

function seedData() {
    const teams = [];
    for (let i = 1; i <= 8; i++) teams.push({ id: i, name: `${i}팀`, points: 0, missionsCount: 0 });

    const now = Date.now();
    const daysAgo = n => new Date(now - n * 86400000).toISOString();

    const submissions = [];
    function addApproved(teamId, missionKey, participants, memo, daysBack, awarded) {
        const m = missionByKey(missionKey);
        const createdAt = daysAgo(daysBack);
        submissions.push({
            id: uid(), teamId, missionKey, category: m.category, label: m.label, emoji: m.emoji,
            participants, memo, photo: placeholderPhoto(m.emoji, teamId + submissions.length),
            status: "approved", createdAt, approvedAt: createdAt,
            awardedPoints: awarded !== undefined ? awarded : m.points,
        });
    }

    addApproved(1, "drink", 5, "OT 뒤풀이 삼겹살집에서!", 3, 10);
    addApproved(1, "study", 4, "알고리즘 스터디 완료", 2, 5);
    addApproved(1, "cafe", 3, "팀플 회의 겸 카페", 1, 5);
    addApproved(1, "photo", 6, "단체 인증샷", 1, 3);

    addApproved(2, "meal", 4, "학식 같이 먹기", 2, 5);
    addApproved(2, "karaoke", 5, "노래방 2시간", 2, 5);
    addApproved(2, "surprise", 6, "1주차 돌발미션: 교수님과 셀카", 1, 15);

    addApproved(3, "drink", 4, "치맥 모임", 3, 10);
    addApproved(3, "cafe", 3, "스터디카페 방문", 1, 5);

    addApproved(4, "study", 3, "코딩테스트 스터디", 2, 5);
    addApproved(4, "photo", 3, "실습실 인증샷", 1, 3);

    submissions.push({
        id: uid(), teamId: 5, missionKey: "meal", category: "일상", label: "밥 먹기", emoji: "🍚",
        participants: 3, memo: "저녁 같이 먹었어요", photo: placeholderPhoto("🍚", 50),
        status: "pending", createdAt: new Date().toISOString(),
    });
    submissions.push({
        id: uid(), teamId: 6, missionKey: "surprise", category: "돌발", label: "주차별 돌발 미션", emoji: "🎯",
        participants: 5, memo: "1주차 돌발미션 참여!", photo: placeholderPhoto("🎯", 60),
        status: "pending", createdAt: new Date().toISOString(), proposedPoints: 15,
    });

    const adjustments = [];

    submissions.filter(s => s.status === "approved").forEach(s => {
        const t = teams.find(t => t.id === s.teamId);
        t.points += s.awardedPoints;
        t.missionsCount += 1;
    });

    return { teams, submissions, adjustments, nextTeamId: 9, campaign: { ...DEFAULT_CAMPAIGN } };
}

function loadData() {
    if (fs.existsSync(DATA_PATH)) {
        try {
            const parsed = JSON.parse(fs.readFileSync(DATA_PATH, "utf-8"));
            if (!parsed.campaign || !parsed.campaign.start || !parsed.campaign.end) {
                parsed.campaign = { ...DEFAULT_CAMPAIGN };
            }
            return parsed;
        } catch (e) {
            console.warn("[hygo] failed to parse stored data, reseeding:", e.message);
        }
    }
    const seeded = seedData();
    fs.mkdirSync(path.dirname(DATA_PATH), { recursive: true });
    fs.writeFileSync(DATA_PATH, JSON.stringify(seeded, null, 2));
    return seeded;
}

let data = loadData();
let writeChain = Promise.resolve();
function persist() {
    fs.mkdirSync(path.dirname(DATA_PATH), { recursive: true });
    writeChain = writeChain.then(() => fs.promises.writeFile(DATA_PATH, JSON.stringify(data, null, 2)));
    return writeChain;
}

function requireAdmin(req, res, next) {
    if (req.get("x-admin-password") !== ADMIN_PASSWORD) {
        return res.status(401).json({ error: "관리자 암호가 올바르지 않습니다." });
    }
    next();
}

const app = express();
const server = http.createServer(app);
const io = new SocketIOServer(server);

app.use(express.static(path.join(__dirname, "public")));
app.use(express.json({ limit: "15mb" }));

const hygoNamespace = io.of("/hygo");
hygoNamespace.on("connection", socket => {
    socket.emit("state", data);
});
const broadcast = () => hygoNamespace.emit("state", data);

app.get("/api/hygo/state", (req, res) => res.json(data));

app.post("/api/hygo/admin/login", (req, res) => {
    if ((req.body || {}).password === ADMIN_PASSWORD) return res.json({ ok: true });
    res.status(401).json({ ok: false, error: "암호가 올바르지 않습니다." });
});

app.post("/api/hygo/submissions", (req, res) => {
    const { teamId, missionKey, participants, memo, photo, proposedPoints } = req.body || {};
    const mission = missionByKey(missionKey);
    const team = data.teams.find(t => t.id === Number(teamId));

    if (!mission) return res.status(400).json({ error: "올바르지 않은 미션 유형입니다." });
    if (!team) return res.status(400).json({ error: "올바르지 않은 팀입니다." });
    if (!Number.isFinite(Number(participants)) || Number(participants) < 3) {
        return res.status(400).json({ error: "참여 인원은 최소 3명 이상이어야 합니다." });
    }
    if (!memo || !String(memo).trim()) return res.status(400).json({ error: "한 줄 메모를 입력해주세요." });
    if (!photo || !String(photo).startsWith("data:image/")) {
        return res.status(400).json({ error: "인증 사진을 업로드해주세요." });
    }

    const sub = {
        id: uid(), teamId: team.id, missionKey: mission.key, category: mission.category,
        label: mission.label, emoji: mission.emoji, participants: Number(participants),
        memo: String(memo).trim(), photo, status: "pending", createdAt: new Date().toISOString(),
    };
    if (mission.category === "돌발") {
        const pts = Number(proposedPoints);
        if (!Number.isFinite(pts) || pts <= 0) {
            return res.status(400).json({ error: "돌발 미션 배점을 입력해주세요." });
        }
        sub.proposedPoints = pts;
    }

    data.submissions.push(sub);
    persist();
    broadcast();
    res.json({ ok: true, submission: sub });
});

app.post("/api/hygo/submissions/:id/approve", requireAdmin, (req, res) => {
    const sub = data.submissions.find(s => s.id === req.params.id);
    if (!sub || sub.status !== "pending") return res.status(404).json({ error: "대기 중인 인증을 찾을 수 없습니다." });
    const team = data.teams.find(t => t.id === sub.teamId);
    const mission = missionByKey(sub.missionKey);
    if (!team || !mission) return res.status(400).json({ error: "잘못된 인증 데이터입니다." });

    let award;
    let capApplied = false;
    if (mission.category === "일상") {
        const day = todayKey(sub.createdAt);
        const sameDayTotal = data.submissions
            .filter(s => s.teamId === sub.teamId && s.status === "approved" && s.category === "일상" && todayKey(s.createdAt) === day)
            .reduce((sum, s) => sum + s.awardedPoints, 0);
        const remaining = Math.max(0, DAILY_CASUAL_CAP - sameDayTotal);
        award = Math.min(mission.points, remaining);
        capApplied = award < mission.points;
    } else {
        award = sub.proposedPoints !== undefined ? sub.proposedPoints : (mission.points || 0);
    }

    sub.status = "approved";
    sub.approvedAt = new Date().toISOString();
    sub.awardedPoints = award;
    team.points += award;
    team.missionsCount += 1;

    persist();
    broadcast();
    res.json({ ok: true, awardedPoints: award, capApplied, teamName: team.name });
});

app.post("/api/hygo/submissions/:id/reject", requireAdmin, (req, res) => {
    const sub = data.submissions.find(s => s.id === req.params.id);
    if (!sub || sub.status !== "pending") return res.status(404).json({ error: "대기 중인 인증을 찾을 수 없습니다." });
    sub.status = "rejected";
    sub.rejectedAt = new Date().toISOString();
    persist();
    broadcast();
    res.json({ ok: true });
});

app.post("/api/hygo/adjustments", requireAdmin, (req, res) => {
    const { teamId, delta, reason } = req.body || {};
    const team = data.teams.find(t => t.id === Number(teamId));
    const deltaNum = Number(delta);
    if (!team) return res.status(400).json({ error: "올바르지 않은 팀입니다." });
    if (!Number.isFinite(deltaNum) || deltaNum === 0) return res.status(400).json({ error: "조정할 점수를 입력해주세요." });

    team.points += deltaNum;
    data.adjustments.push({ id: uid(), teamId: team.id, delta: deltaNum, reason: (reason || "").trim(), date: new Date().toISOString() });
    persist();
    broadcast();
    res.json({ ok: true, teamName: team.name, points: team.points });
});

app.post("/api/hygo/teams", requireAdmin, (req, res) => {
    const name = ((req.body || {}).name || "").trim();
    const id = data.nextTeamId || (Math.max(0, ...data.teams.map(t => t.id)) + 1);
    const team = { id, name: name || `${id}팀`, points: 0, missionsCount: 0 };
    data.teams.push(team);
    data.nextTeamId = id + 1;
    persist();
    broadcast();
    res.json({ ok: true, team });
});

app.delete("/api/hygo/teams/:id", requireAdmin, (req, res) => {
    const id = Number(req.params.id);
    if (data.teams.length <= 1) return res.status(400).json({ error: "최소 한 팀은 남아있어야 합니다." });
    const idx = data.teams.findIndex(t => t.id === id);
    if (idx === -1) return res.status(404).json({ error: "팀을 찾을 수 없습니다." });

    data.teams.splice(idx, 1);
    data.submissions = data.submissions.filter(s => s.teamId !== id);
    data.adjustments = data.adjustments.filter(a => a.teamId !== id);
    persist();
    broadcast();
    res.json({ ok: true });
});

app.delete("/api/hygo/submissions/:id", requireAdmin, (req, res) => {
    const idx = data.submissions.findIndex(s => s.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: "인증을 찾을 수 없습니다." });
    const sub = data.submissions[idx];
    if (sub.status === "approved") {
        const team = data.teams.find(t => t.id === sub.teamId);
        if (team) {
            team.points -= sub.awardedPoints;
            team.missionsCount = Math.max(0, team.missionsCount - 1);
        }
    }
    data.submissions.splice(idx, 1);
    persist();
    broadcast();
    res.json({ ok: true });
});

app.post("/api/hygo/campaign", requireAdmin, (req, res) => {
    const { start, end } = req.body || {};
    const dateRe = /^\d{4}-\d{2}-\d{2}$/;
    if (!dateRe.test(start) || !dateRe.test(end)) {
        return res.status(400).json({ error: "날짜 형식이 올바르지 않습니다." });
    }
    if (end < start) return res.status(400).json({ error: "종료일이 시작일보다 빠를 수 없습니다." });
    const days = (new Date(end) - new Date(start)) / 86400000;
    if (days > 366) return res.status(400).json({ error: "기간이 너무 깁니다 (최대 1년)." });

    data.campaign = { start, end };
    persist();
    broadcast();
    res.json({ ok: true, campaign: data.campaign });
});

app.post("/api/hygo/reset", requireAdmin, (req, res) => {
    data = seedData();
    persist();
    broadcast();
    res.json({ ok: true });
});

app.post("/api/hygo/reset-zero", requireAdmin, (req, res) => {
    data.teams = data.teams.map(t => ({ ...t, points: 0, missionsCount: 0 }));
    data.submissions = [];
    data.adjustments = [];
    persist();
    broadcast();
    res.json({ ok: true });
});

app.post("/api/hygo/import", requireAdmin, (req, res) => {
    const incoming = req.body;
    if (!incoming || !Array.isArray(incoming.teams) || !Array.isArray(incoming.submissions) || !Array.isArray(incoming.adjustments)) {
        return res.status(400).json({ error: "올바른 백업 파일이 아닙니다." });
    }
    data = {
        teams: incoming.teams,
        submissions: incoming.submissions,
        adjustments: incoming.adjustments,
        nextTeamId: incoming.nextTeamId || (Math.max(0, ...incoming.teams.map(t => t.id)) + 1),
        campaign: (incoming.campaign && incoming.campaign.start && incoming.campaign.end) ? incoming.campaign : { ...DEFAULT_CAMPAIGN },
    };
    persist();
    broadcast();
    res.json({ ok: true });
});

const PORT = process.env.HYGO_PORT || 4000;
server.listen(PORT, "0.0.0.0", () => {
    console.log(`HY-GO server running on port ${PORT}`);
});
