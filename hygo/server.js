// HY-GO 네트워킹 프로그램 — 독립 서버.
// 메인 프로젝트(server.js, Project LIFE 게임)와는 완전히 분리된 별도 앱이다.
// 실행: node hygo/server.js  (포트는 HYGO_PORT, 기본 4000)

require("dotenv").config();
const fs = require("fs");
const path = require("path");
const http = require("http");
const express = require("express");
const cookieParser = require("cookie-parser");
const { Server: SocketIOServer } = require("socket.io");

const ADMIN_PASSWORD = process.env.HYGO_ADMIN_PASSWORD || "hyai0926";
const DAILY_CASUAL_CAP = 15;
const DATA_PATH = path.join(__dirname, "data", "hygo-data.json");
const DEFAULT_CAMPAIGN = { start: "2026-09-21", end: "2026-10-30" };
const WEBHOOK_URL = process.env.HYGO_WEBHOOK_URL || "";

// ---------- 카카오 로그인 ----------
// KAKAO_*_URL은 기본값이 실제 카카오 서버지만, 로컬 테스트 때는 가짜 서버로 오버라이드해서 검증한다.
const KAKAO_REST_API_KEY = process.env.KAKAO_REST_API_KEY || "";
const KAKAO_CLIENT_SECRET = process.env.KAKAO_CLIENT_SECRET || "";
const KAKAO_REDIRECT_URI = process.env.KAKAO_REDIRECT_URI || "";
const KAKAO_AUTHORIZE_URL = process.env.KAKAO_AUTHORIZE_URL || "https://kauth.kakao.com/oauth/authorize";
const KAKAO_TOKEN_URL = process.env.KAKAO_TOKEN_URL || "https://kauth.kakao.com/oauth/token";
const KAKAO_USERINFO_URL = process.env.KAKAO_USERINFO_URL || "https://kapi.kakao.com/v2/user/me";
const COOKIE_SECRET = process.env.COOKIE_SECRET || "hygo-dev-secret-please-change";
const COOKIE_MAX_AGE = 1000 * 60 * 60 * 24 * 180; // 180일

// Upstash Redis(REST) 설정 — 지정돼 있으면 여기에 저장해서 Render 재시작/슬립 후에도 데이터가 남는다.
// 지정 안 돼 있으면 로컬 파일(data/hygo-data.json)로 동작하되, 그 경우 Render 무료 플랜에서는 재시작 시 초기화된다.
const REDIS_URL = (process.env.UPSTASH_REDIS_REST_URL || "").replace(/\/$/, "");
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || "";
const REDIS_ENABLED = !!(REDIS_URL && REDIS_TOKEN);
const REDIS_KEY = "hygo:data";

async function redisGetData() {
    const res = await fetch(`${REDIS_URL}/get/${REDIS_KEY}`, {
        headers: { Authorization: `Bearer ${REDIS_TOKEN}` },
    });
    if (!res.ok) throw new Error(`Upstash GET failed (${res.status})`);
    const json = await res.json();
    return json.result ? JSON.parse(json.result) : null;
}

async function redisSetData(value) {
    const res = await fetch(`${REDIS_URL}/set/${REDIS_KEY}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${REDIS_TOKEN}`, "Content-Type": "text/plain" },
        body: JSON.stringify(value),
    });
    if (!res.ok) throw new Error(`Upstash SET failed (${res.status})`);
}

// ---------- 사진 저장 (메인 데이터 블록과 분리) ----------
// 사진을 메인 데이터에 같이 넣으면 인증 하나 승인될 때마다 그동안 쌓인 사진을
// 전부 다시 업로드하게 돼서 Upstash 무료 요청 크기 제한(약 1MB)에 금방 걸린다.
// 그래서 사진은 인증 건마다 별도 키/파일로 저장하고, 메인 데이터에는 그 위치를 가리키는
// 가벼운 URL(`/api/hygo/photo/:id`)만 남긴다.
const PHOTOS_DIR = path.join(__dirname, "data", "photos");
const photoRedisKey = id => `hygo:photo:${id}`;
const isStoredPhotoRef = photo => typeof photo === "string" && photo.startsWith("/api/hygo/photo/");
const photoRefId = photo => photo.split("/").pop();

async function savePhoto(id, dataUri) {
    if (REDIS_ENABLED) {
        const res = await fetch(`${REDIS_URL}/set/${photoRedisKey(id)}`, {
            method: "POST",
            headers: { Authorization: `Bearer ${REDIS_TOKEN}`, "Content-Type": "text/plain" },
            body: dataUri,
        });
        if (!res.ok) throw new Error(`Upstash photo SET failed (${res.status})`);
        return;
    }
    fs.mkdirSync(PHOTOS_DIR, { recursive: true });
    await fs.promises.writeFile(path.join(PHOTOS_DIR, `${id}.txt`), dataUri, "utf-8");
}

async function loadPhoto(id) {
    if (REDIS_ENABLED) {
        const res = await fetch(`${REDIS_URL}/get/${photoRedisKey(id)}`, {
            headers: { Authorization: `Bearer ${REDIS_TOKEN}` },
        });
        if (!res.ok) throw new Error(`Upstash photo GET failed (${res.status})`);
        const json = await res.json();
        return json.result || null;
    }
    const p = path.join(PHOTOS_DIR, `${id}.txt`);
    if (!fs.existsSync(p)) return null;
    return fs.promises.readFile(p, "utf-8");
}

async function deletePhoto(id) {
    try {
        if (REDIS_ENABLED) {
            await fetch(`${REDIS_URL}/del/${photoRedisKey(id)}`, {
                method: "POST",
                headers: { Authorization: `Bearer ${REDIS_TOKEN}` },
            });
        } else {
            const p = path.join(PHOTOS_DIR, `${id}.txt`);
            if (fs.existsSync(p)) await fs.promises.unlink(p);
        }
    } catch (e) {
        console.warn(`[hygo] failed to delete photo ${id}:`, e.message);
    }
}

// 디스코드/슬랙 호환 인커밍 웹훅으로 알림을 보낸다. 실패해도 요청 흐름에는 영향을 주지 않는다.
function notifyWebhook(message) {
    if (!WEBHOOK_URL) return;
    fetch(WEBHOOK_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: message, text: message }),
    }).catch(err => console.warn("[hygo] webhook notify failed:", err.message));
}

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

const REACTION_TYPES = ["love", "funny", "fire", "annoyed", "clap"];
const emptyReactions = () => ({ love: 0, funny: 0, fire: 0, annoyed: 0, clap: 0 });

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
            awardedPoints: awarded !== undefined ? awarded : m.points, comments: [], reactions: emptyReactions(), reactedBy: {},
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
        status: "pending", createdAt: new Date().toISOString(), comments: [], reactions: emptyReactions(), reactedBy: {},
    });
    submissions.push({
        id: uid(), teamId: 6, missionKey: "surprise", category: "돌발", label: "주차별 돌발 미션", emoji: "🎯",
        participants: 5, memo: "1주차 돌발미션 참여!", photo: placeholderPhoto("🎯", 60),
        status: "pending", createdAt: new Date().toISOString(), proposedPoints: 15, comments: [], reactions: emptyReactions(), reactedBy: {},
    });

    const adjustments = [];

    submissions.filter(s => s.status === "approved").forEach(s => {
        const t = teams.find(t => t.id === s.teamId);
        t.points += s.awardedPoints;
        t.missionsCount += 1;
    });

    return { teams, submissions, adjustments, nextTeamId: 9, campaign: { ...DEFAULT_CAMPAIGN }, users: [] };
}

function normalizeCampaign(parsed) {
    if (!parsed.campaign || !parsed.campaign.start || !parsed.campaign.end) {
        parsed.campaign = { ...DEFAULT_CAMPAIGN };
    }
    if (!Array.isArray(parsed.users)) parsed.users = [];
    if (Array.isArray(parsed.submissions)) {
        parsed.submissions.forEach(s => {
            if (!Array.isArray(s.comments)) s.comments = [];
            s.comments.forEach(c => { if (typeof c.reported !== "boolean") c.reported = false; });
            if (!s.reactedBy || typeof s.reactedBy !== "object") s.reactedBy = {};
            if (!s.reactions || typeof s.reactions !== "object") s.reactions = emptyReactions();
            REACTION_TYPES.forEach(key => { if (typeof s.reactions[key] !== "number") s.reactions[key] = 0; });
        });
    }
    return parsed;
}

async function loadData() {
    if (REDIS_ENABLED) {
        try {
            const remote = await redisGetData();
            if (remote) return normalizeCampaign(remote);
        } catch (e) {
            console.warn("[hygo] Upstash read failed, seeding fresh data instead:", e.message);
        }
        const seeded = seedData();
        try {
            await redisSetData(seeded);
        } catch (e) {
            console.warn("[hygo] Upstash write failed during initial seed:", e.message);
        }
        return seeded;
    }

    if (fs.existsSync(DATA_PATH)) {
        try {
            return normalizeCampaign(JSON.parse(fs.readFileSync(DATA_PATH, "utf-8")));
        } catch (e) {
            console.warn("[hygo] failed to parse stored data, reseeding:", e.message);
        }
    }
    const seeded = seedData();
    fs.mkdirSync(path.dirname(DATA_PATH), { recursive: true });
    fs.writeFileSync(DATA_PATH, JSON.stringify(seeded, null, 2));
    return seeded;
}

let data;
let writeChain = Promise.resolve();
function persist() {
    writeChain = writeChain.then(async () => {
        if (REDIS_ENABLED) {
            try {
                await redisSetData(data);
            } catch (e) {
                console.warn("[hygo] Upstash write failed:", e.message);
            }
            return;
        }
        fs.mkdirSync(path.dirname(DATA_PATH), { recursive: true });
        await fs.promises.writeFile(DATA_PATH, JSON.stringify(data, null, 2));
    });
    return writeChain;
}

function requireAdmin(req, res, next) {
    if (req.get("x-admin-password") !== ADMIN_PASSWORD) {
        return res.status(401).json({ error: "관리자 암호가 올바르지 않습니다." });
    }
    next();
}

function getCurrentUser(req) {
    const uidCookie = req.signedCookies && req.signedCookies.hygo_uid;
    if (!uidCookie) return null;
    return data.users.find(u => u.id === uidCookie) || null;
}

function requireLogin(req, res, next) {
    const user = getCurrentUser(req);
    if (!user) return res.status(401).json({ error: "카카오 로그인이 필요합니다." });
    req.hygoUser = user;
    next();
}

const app = express();
const server = http.createServer(app);
const io = new SocketIOServer(server);

app.use(express.static(path.join(__dirname, "public")));
app.use(express.json({ limit: "15mb" }));
app.use(cookieParser(COOKIE_SECRET));

const hygoNamespace = io.of("/hygo");
hygoNamespace.on("connection", socket => {
    socket.emit("state", data);
});
const broadcast = () => hygoNamespace.emit("state", data);

app.get("/api/hygo/state", (req, res) => res.json(data));

app.get("/api/hygo/photo/:id", async (req, res) => {
    try {
        const dataUri = await loadPhoto(req.params.id);
        if (!dataUri) return res.status(404).send("Not found");
        const match = /^data:([^;]+);base64,(.*)$/.exec(dataUri);
        if (!match) return res.status(500).send("Invalid photo data");
        const [, mime, b64] = match;
        res.set("Content-Type", mime);
        res.set("Cache-Control", "public, max-age=31536000, immutable");
        res.send(Buffer.from(b64, "base64"));
    } catch (e) {
        res.status(500).send("Photo load failed");
    }
});

app.post("/api/hygo/admin/login", (req, res) => {
    if ((req.body || {}).password === ADMIN_PASSWORD) return res.json({ ok: true });
    res.status(401).json({ ok: false, error: "암호가 올바르지 않습니다." });
});

// ---------- 카카오 로그인 ----------
function kakaoRedirectUri(req) {
    return KAKAO_REDIRECT_URI || `${req.protocol}://${req.get("host")}/api/hygo/auth/kakao/callback`;
}

app.get("/api/hygo/auth/kakao/login", (req, res) => {
    if (!KAKAO_REST_API_KEY) return res.status(501).send("카카오 로그인이 아직 설정되지 않았습니다. 관리자에게 문의해주세요.");
    const url = `${KAKAO_AUTHORIZE_URL}?client_id=${encodeURIComponent(KAKAO_REST_API_KEY)}&redirect_uri=${encodeURIComponent(kakaoRedirectUri(req))}&response_type=code`;
    res.redirect(url);
});

app.get("/api/hygo/auth/kakao/callback", async (req, res) => {
    const { code, error } = req.query;
    if (error || !code) return res.redirect("/?loginError=1");
    try {
        const tokenParams = new URLSearchParams({
            grant_type: "authorization_code",
            client_id: KAKAO_REST_API_KEY,
            redirect_uri: kakaoRedirectUri(req),
            code: String(code),
        });
        if (KAKAO_CLIENT_SECRET) tokenParams.set("client_secret", KAKAO_CLIENT_SECRET);

        const tokenRes = await fetch(KAKAO_TOKEN_URL, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: tokenParams.toString(),
        });
        if (!tokenRes.ok) throw new Error(`token exchange failed (${tokenRes.status})`);
        const tokenJson = await tokenRes.json();

        const userRes = await fetch(KAKAO_USERINFO_URL, {
            headers: { Authorization: `Bearer ${tokenJson.access_token}` },
        });
        if (!userRes.ok) throw new Error(`user info fetch failed (${userRes.status})`);
        const userJson = await userRes.json();

        const kakaoId = String(userJson.id);
        const account = userJson.kakao_account || {};
        const profile = account.profile || {};
        const nickname = profile.nickname || "카카오 사용자";
        const profileImage = profile.profile_image_url || "";

        let user = data.users.find(u => u.id === kakaoId);
        if (!user) {
            user = { id: kakaoId, nickname, profileImage, teamId: null, createdAt: new Date().toISOString() };
            data.users.push(user);
        } else {
            user.nickname = nickname;
            user.profileImage = profileImage;
        }
        persist();
        broadcast();

        res.cookie("hygo_uid", kakaoId, { httpOnly: true, signed: true, sameSite: "lax", maxAge: COOKIE_MAX_AGE });
        res.redirect("/");
    } catch (e) {
        console.warn("[hygo] kakao login failed:", e.message);
        res.redirect("/?loginError=1");
    }
});

app.post("/api/hygo/auth/logout", (req, res) => {
    res.clearCookie("hygo_uid");
    res.json({ ok: true });
});

app.get("/api/hygo/auth/me", (req, res) => {
    const user = getCurrentUser(req);
    if (!user) return res.status(401).json({ error: "로그인이 필요합니다." });
    res.json({ user });
});

app.post("/api/hygo/auth/team", requireLogin, (req, res) => {
    const teamId = Number((req.body || {}).teamId);
    const team = data.teams.find(t => t.id === teamId);
    if (!team) return res.status(400).json({ error: "올바르지 않은 팀입니다." });
    req.hygoUser.teamId = teamId;
    persist();
    broadcast();
    res.json({ ok: true, user: req.hygoUser });
});

app.post("/api/hygo/submissions", requireLogin, async (req, res) => {
    const user = req.hygoUser;
    if (!user.teamId) return res.status(400).json({ error: "먼저 소속 팀을 선택해주세요." });
    const { missionKey, participants, memo, photo, proposedPoints } = req.body || {};
    const mission = missionByKey(missionKey);
    const team = data.teams.find(t => t.id === user.teamId);

    if (!mission) return res.status(400).json({ error: "올바르지 않은 미션 유형입니다." });
    if (!team) return res.status(400).json({ error: "소속 팀을 찾을 수 없습니다. 팀을 다시 선택해주세요." });
    if (!Number.isFinite(Number(participants)) || Number(participants) < 3) {
        return res.status(400).json({ error: "참여 인원은 최소 3명 이상이어야 합니다." });
    }
    if (!memo || !String(memo).trim()) return res.status(400).json({ error: "한 줄 메모를 입력해주세요." });
    if (!photo || !String(photo).startsWith("data:image/")) {
        return res.status(400).json({ error: "인증 사진을 업로드해주세요." });
    }

    const id = uid();
    const sub = {
        id, teamId: team.id, missionKey: mission.key, category: mission.category,
        label: mission.label, emoji: mission.emoji, participants: Number(participants),
        memo: String(memo).trim(), photo: `/api/hygo/photo/${id}`, status: "pending", createdAt: new Date().toISOString(),
        authorId: user.id, comments: [], reactions: emptyReactions(), reactedBy: {},
    };
    if (mission.category === "돌발") {
        const pts = Number(proposedPoints);
        if (!Number.isFinite(pts) || pts <= 0) {
            return res.status(400).json({ error: "돌발 미션 배점을 입력해주세요." });
        }
        sub.proposedPoints = pts;
    }

    try {
        await savePhoto(id, photo);
    } catch (e) {
        return res.status(502).json({ error: "사진 저장에 실패했습니다. 잠시 후 다시 시도해주세요." });
    }

    data.submissions.push(sub);
    persist();
    broadcast();
    notifyWebhook(`📸 새 미션 인증 대기 중!\n${team.name} · ${mission.emoji} ${mission.label}\n"${sub.memo}"\nHY-GO 관리자 페이지에서 승인해주세요.`);
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
    sub.rejectionReason = ((req.body || {}).reason || "").trim();
    persist();
    broadcast();
    res.json({ ok: true });
});

app.post("/api/hygo/submissions/:id/comments", requireLogin, (req, res) => {
    const user = req.hygoUser;
    const sub = data.submissions.find(s => s.id === req.params.id);
    if (!sub) return res.status(404).json({ error: "인증을 찾을 수 없습니다." });
    const { text, anonymous } = req.body || {};
    if (!text || !String(text).trim()) return res.status(400).json({ error: "댓글 내용을 입력해주세요." });

    const comment = {
        id: uid(),
        authorId: user.id,
        authorName: anonymous ? "익명" : (user.nickname || "익명"),
        text: String(text).trim().slice(0, 200),
        createdAt: new Date().toISOString(),
        reported: false,
    };
    if (!Array.isArray(sub.comments)) sub.comments = [];
    sub.comments.push(comment);
    persist();
    broadcast();
    res.json({ ok: true, comment });
});

app.post("/api/hygo/comments/:id/report", requireLogin, (req, res) => {
    for (const sub of data.submissions) {
        if (!Array.isArray(sub.comments)) continue;
        const comment = sub.comments.find(c => c.id === req.params.id);
        if (comment) {
            comment.reported = true;
            comment.reportedAt = new Date().toISOString();
            persist();
            broadcast();
            return res.json({ ok: true });
        }
    }
    res.status(404).json({ error: "댓글을 찾을 수 없습니다." });
});

app.post("/api/hygo/comments/:id/restore", requireAdmin, (req, res) => {
    for (const sub of data.submissions) {
        if (!Array.isArray(sub.comments)) continue;
        const comment = sub.comments.find(c => c.id === req.params.id);
        if (comment) {
            comment.reported = false;
            delete comment.reportedAt;
            persist();
            broadcast();
            return res.json({ ok: true });
        }
    }
    res.status(404).json({ error: "댓글을 찾을 수 없습니다." });
});

app.delete("/api/hygo/comments/:id", (req, res) => {
    const user = getCurrentUser(req);
    const isAdminReq = req.get("x-admin-password") === ADMIN_PASSWORD;
    for (const sub of data.submissions) {
        if (!Array.isArray(sub.comments)) continue;
        const idx = sub.comments.findIndex(c => c.id === req.params.id);
        if (idx !== -1) {
            const comment = sub.comments[idx];
            const isOwner = user && comment.authorId === user.id;
            if (!isOwner && !isAdminReq) return res.status(401).json({ error: "삭제 권한이 없습니다." });
            sub.comments.splice(idx, 1);
            persist();
            broadcast();
            return res.json({ ok: true });
        }
    }
    res.status(404).json({ error: "댓글을 찾을 수 없습니다." });
});

// 계정별로 실제 로그인한 사용자 ID에 반응을 매핑해서 저장한다(reactedBy). 카운트(reactions)는
// 그 매핑을 집계해서 다시 계산하기 때문에, 클라이언트가 뭘 보내든 서버 쪽에서 어긋날 수가 없다.
app.post("/api/hygo/submissions/:id/react", requireLogin, (req, res) => {
    const user = req.hygoUser;
    const sub = data.submissions.find(s => s.id === req.params.id);
    if (!sub) return res.status(404).json({ error: "인증을 찾을 수 없습니다." });
    const { emoji } = req.body || {};
    if (emoji != null && !REACTION_TYPES.includes(emoji)) return res.status(400).json({ error: "올바르지 않은 반응입니다." });

    if (!sub.reactedBy || typeof sub.reactedBy !== "object") sub.reactedBy = {};
    const current = sub.reactedBy[user.id] || null;
    const next = current === emoji ? null : emoji;
    if (next) sub.reactedBy[user.id] = next; else delete sub.reactedBy[user.id];

    sub.reactions = emptyReactions();
    Object.values(sub.reactedBy).forEach(e => { if (REACTION_TYPES.includes(e)) sub.reactions[e] += 1; });

    persist();
    broadcast();
    res.json({ ok: true, reactions: sub.reactions, myReaction: next });
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

app.delete("/api/hygo/teams/:id", requireAdmin, async (req, res) => {
    const id = Number(req.params.id);
    if (data.teams.length <= 1) return res.status(400).json({ error: "최소 한 팀은 남아있어야 합니다." });
    const idx = data.teams.findIndex(t => t.id === id);
    if (idx === -1) return res.status(404).json({ error: "팀을 찾을 수 없습니다." });

    const removedSubmissions = data.submissions.filter(s => s.teamId === id);
    data.teams.splice(idx, 1);
    data.submissions = data.submissions.filter(s => s.teamId !== id);
    data.adjustments = data.adjustments.filter(a => a.teamId !== id);
    persist();
    broadcast();
    res.json({ ok: true });

    for (const sub of removedSubmissions) {
        if (isStoredPhotoRef(sub.photo)) await deletePhoto(photoRefId(sub.photo));
    }
});

// 거절된(rejected) 인증은 점수에 영향이 없어서, 팀원이 사유를 확인한 뒤 직접 지울 수 있게
// 관리자 암호 없이도 삭제를 허용한다. 대기/승인 상태는 그대로 관리자만 지울 수 있다.
app.delete("/api/hygo/submissions/:id", async (req, res) => {
    const idx = data.submissions.findIndex(s => s.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: "인증을 찾을 수 없습니다." });
    const sub = data.submissions[idx];
    if (sub.status !== "rejected" && req.get("x-admin-password") !== ADMIN_PASSWORD) {
        return res.status(401).json({ error: "관리자 암호가 올바르지 않습니다." });
    }
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

    if (isStoredPhotoRef(sub.photo)) await deletePhoto(photoRefId(sub.photo));
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

app.get("/api/hygo/export", requireAdmin, async (req, res) => {
    try {
        const exported = JSON.parse(JSON.stringify(data));
        for (const sub of exported.submissions) {
            if (isStoredPhotoRef(sub.photo)) {
                const real = await loadPhoto(photoRefId(sub.photo));
                if (real) sub.photo = real;
            }
        }
        res.json(exported);
    } catch (e) {
        res.status(500).json({ error: "백업 생성에 실패했습니다." });
    }
});

app.post("/api/hygo/reset", requireAdmin, async (req, res) => {
    const oldSubmissions = data.submissions;
    const keepUsers = data.users;
    data = seedData();
    data.users = keepUsers; // 계정(카카오 로그인)은 점수/미션 초기화와 별개로 유지한다
    persist();
    broadcast();
    res.json({ ok: true });

    for (const sub of oldSubmissions) {
        if (isStoredPhotoRef(sub.photo)) await deletePhoto(photoRefId(sub.photo));
    }
});

app.post("/api/hygo/reset-zero", requireAdmin, async (req, res) => {
    const oldSubmissions = data.submissions;
    data.teams = data.teams.map(t => ({ ...t, points: 0, missionsCount: 0 }));
    data.submissions = [];
    data.adjustments = [];
    persist();
    broadcast();
    res.json({ ok: true });

    for (const sub of oldSubmissions) {
        if (isStoredPhotoRef(sub.photo)) await deletePhoto(photoRefId(sub.photo));
    }
});

app.post("/api/hygo/import", requireAdmin, async (req, res) => {
    const incoming = req.body;
    if (!incoming || !Array.isArray(incoming.teams) || !Array.isArray(incoming.submissions) || !Array.isArray(incoming.adjustments)) {
        return res.status(400).json({ error: "올바른 백업 파일이 아닙니다." });
    }

    const oldSubmissions = data.submissions;
    const importedSubmissions = [];
    for (const sub of incoming.submissions) {
        const clone = { ...sub };
        if (typeof clone.photo === "string" && clone.photo.startsWith("data:image/")) {
            try {
                await savePhoto(clone.id, clone.photo);
                clone.photo = `/api/hygo/photo/${clone.id}`;
            } catch (e) {
                return res.status(502).json({ error: "백업 사진 복원에 실패했습니다." });
            }
        }
        importedSubmissions.push(clone);
    }

    data = {
        teams: incoming.teams,
        submissions: importedSubmissions,
        adjustments: incoming.adjustments,
        nextTeamId: incoming.nextTeamId || (Math.max(0, ...incoming.teams.map(t => t.id)) + 1),
        campaign: (incoming.campaign && incoming.campaign.start && incoming.campaign.end) ? incoming.campaign : { ...DEFAULT_CAMPAIGN },
        users: Array.isArray(incoming.users) ? incoming.users : [],
    };
    persist();
    broadcast();
    res.json({ ok: true });

    for (const sub of oldSubmissions) {
        if (isStoredPhotoRef(sub.photo)) await deletePhoto(photoRefId(sub.photo));
    }
});

async function main() {
    data = await loadData();
    const PORT = process.env.HYGO_PORT || 4000;
    server.listen(PORT, "0.0.0.0", () => {
        console.log(`HY-GO server running on port ${PORT}`);
        console.log(REDIS_ENABLED
            ? "[hygo] persistent storage: Upstash Redis (data survives restarts)"
            : "[hygo] persistent storage: local file — WARNING: data will NOT survive Render restarts/sleep on the free tier");
    });
}

main();
