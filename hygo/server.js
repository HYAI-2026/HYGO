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

const DEFAULT_MISSIONS = [
    { key: "drink", category: "일상", emoji: "🍺", label: "술 마시기", points: 10 },
    { key: "meal", category: "일상", emoji: "🍚", label: "밥 먹기", points: 5 },
    { key: "cafe", category: "일상", emoji: "☕", label: "카페 가기", points: 5 },
    { key: "karaoke", category: "일상", emoji: "🎤", label: "노래방 가기", points: 5 },
    { key: "study", category: "일상", emoji: "📚", label: "공부/코딩하기", points: 5 },
    { key: "photo", category: "일상", emoji: "📸", label: "인증샷 찍기", points: 3 },
    { key: "surprise", category: "돌발", emoji: "🎯", label: "주차별 돌발 미션", points: 15 },
];
const MISSION_CATEGORIES = ["일상", "돌발"];

// ---------- 신청서(팀 배정용 설문) ----------
const APPLICATION_DAYS = ["월", "화", "수", "목", "금"];
const APPLICATION_SLOTS = ["08-10", "10-12", "12-14", "14-16", "16-18", "18-20", "20-22"];
const ACTIVITY_STYLE_OPTIONS = [
    "새로운 사람들과 금방 친해지는 편이다.",
    "먼저 다가가지는 않지만 친해지면 활발한 편이다.",
    "조용한 편이다.",
];
const TEAM_VIBE_OPTIONS = ["활동 엄청 열심히", "적당히", "부담 없이"];
const WEEKEND_OPTIONS = ["토요일 가능", "일요일 가능", "토·일 모두 가능", "주말은 어려움"];
const FREQUENCY_OPTIONS = ["거의 매일", "주 3~4회", "주 1~2회"];
const DEFAULT_ACTIVITY_OPTIONS = [
    "독도 가기", "놀이동산", "해외여행", "한강 가기", "축제 즐기기", "귀곡산장", "롤링페이퍼",
    "펌프아케이드", "방탈출", "클레이 대결", "닌텐도 스위치 대결", "단풍 구경", "당구", "볼링",
    "탁구", "스포츠 몬스터", "릴스 찍기", "캠핑", "쇼핑", "영화 관람",
];

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
        const m = DEFAULT_MISSIONS.find(x => x.key === missionKey);
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
        status: "pending", createdAt: new Date().toISOString(), comments: [], reactions: emptyReactions(), reactedBy: {},
    });

    const adjustments = [];

    submissions.filter(s => s.status === "approved").forEach(s => {
        const t = teams.find(t => t.id === s.teamId);
        t.points += s.awardedPoints;
        t.missionsCount += 1;
    });

    return {
        teams, submissions, adjustments, nextTeamId: 9, campaign: { ...DEFAULT_CAMPAIGN }, users: [],
        missions: DEFAULT_MISSIONS.map(m => ({ ...m })),
        applications: [], activityOptions: DEFAULT_ACTIVITY_OPTIONS.slice(),
    };
}

function normalizeCampaign(parsed) {
    if (!parsed.campaign || !parsed.campaign.start || !parsed.campaign.end) {
        parsed.campaign = { ...DEFAULT_CAMPAIGN };
    }
    if (!Array.isArray(parsed.users)) parsed.users = [];
    parsed.users.forEach(u => { if (typeof u.registered !== "boolean") u.registered = false; });
    if (!Array.isArray(parsed.missions) || !parsed.missions.length) parsed.missions = DEFAULT_MISSIONS.map(m => ({ ...m }));
    parsed.missions.forEach(m => { if (m.points == null) m.points = 0; });
    if (!Array.isArray(parsed.applications)) parsed.applications = [];
    // 탈퇴 등으로 사용자가 사라졌는데 신청서만 남아있는 경우를 정리한다 (통계 집계가 부풀려지는 원인이었음).
    const existingUserIds = new Set(parsed.users.map(u => u.id));
    parsed.applications = parsed.applications.filter(a => existingUserIds.has(a.userId));
    if (!Array.isArray(parsed.activityOptions) || !parsed.activityOptions.length) parsed.activityOptions = DEFAULT_ACTIVITY_OPTIONS.slice();
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
    try {
        fs.mkdirSync(path.dirname(DATA_PATH), { recursive: true });
        fs.writeFileSync(DATA_PATH, JSON.stringify(seeded, null, 2));
    } catch (e) {
        console.warn("[hygo] failed to write initial seed file (continuing in-memory):", e.message);
    }
    return seeded;
}

let data;
const missionByKey = key => data.missions.find(m => m.key === key);

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
        try {
            fs.mkdirSync(path.dirname(DATA_PATH), { recursive: true });
            await fs.promises.writeFile(DATA_PATH, JSON.stringify(data, null, 2));
        } catch (e) {
            console.warn("[hygo] local file write failed:", e.message);
        }
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

// 인적사항(이름/학번/학과/생년월일/전화번호/성별)은 관리자 전용 API로만 노출한다.
// data 전체를 그대로 방송하는 상태 동기화(state)에는 절대 포함하면 안 된다.
const PRIVATE_USER_FIELDS = ["name", "studentId", "department", "birthdate", "phone", "gender"];
function sanitizeUser(u) {
    const clean = { ...u };
    PRIVATE_USER_FIELDS.forEach(f => delete clean[f]);
    return clean;
}
// 신청서(data.applications)는 팀 배정 신청 내용(같이 팀 되고 싶은 사람, 기타 의견 등)을
// 담고 있어 민감할 수 있으므로 전체 방송(state)에서는 빼고 관리자 전용 API로만 노출한다.
function publicState() {
    const { applications, ...rest } = data;
    return { ...rest, users: data.users.map(sanitizeUser) };
}

const app = express();
const server = http.createServer(app);
const io = new SocketIOServer(server);

app.use(express.static(path.join(__dirname, "public")));
app.use(express.json({ limit: "15mb" }));
app.use(cookieParser(COOKIE_SECRET));

const hygoNamespace = io.of("/hygo");
hygoNamespace.on("connection", socket => {
    socket.emit("state", publicState());
});
const broadcast = () => hygoNamespace.emit("state", publicState());

app.get("/api/hygo/state", (req, res) => res.json(publicState()));

app.get("/api/hygo/photo/:id", async (req, res) => {
    // id는 항상 서버가 uid()로 생성한 영숫자 문자열이어야 한다. 검증 없이 파일 경로(로컬 저장 모드)에
    // 그대로 꽂으면 "../"가 섞인 값으로 저장 폴더 밖의 파일을 읽어내는 경로 순회 공격이 가능해진다.
    if (!/^[a-zA-Z0-9_-]+$/.test(req.params.id)) return res.status(400).send("Invalid id");
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
        if (!tokenRes.ok) {
            const errBody = await tokenRes.text().catch(() => "");
            console.warn("[hygo] kakao token exchange failed:", tokenRes.status, errBody);
            throw new Error(`token_exchange_${tokenRes.status}`);
        }
        const tokenJson = await tokenRes.json();

        const userRes = await fetch(KAKAO_USERINFO_URL, {
            headers: { Authorization: `Bearer ${tokenJson.access_token}` },
        });
        if (!userRes.ok) {
            const errBody = await userRes.text().catch(() => "");
            console.warn("[hygo] kakao userinfo fetch failed:", userRes.status, errBody);
            throw new Error(`userinfo_${userRes.status}`);
        }
        const userJson = await userRes.json();

        const kakaoId = String(userJson.id);
        const account = userJson.kakao_account || {};
        const profile = account.profile || {};
        const nickname = profile.nickname || "카카오 사용자";
        const profileImage = profile.profile_image_url || "";

        let user = data.users.find(u => u.id === kakaoId);
        if (!user) {
            user = { id: kakaoId, nickname, profileImage, teamId: null, registered: false, createdAt: new Date().toISOString() };
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
        res.redirect(`/?loginError=1&reason=${encodeURIComponent(e.message)}`);
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

const GENDER_OPTIONS = ["남성", "여성"];
app.post("/api/hygo/auth/register", requireLogin, (req, res) => {
    const { name, studentId, department, birthdate, phone, gender } = req.body || {};
    const fields = { name, studentId, department, birthdate, phone, gender };
    for (const v of Object.values(fields)) {
        if (!v || !String(v).trim()) return res.status(400).json({ error: "모든 항목을 입력해주세요." });
    }
    if (!GENDER_OPTIONS.includes(gender)) return res.status(400).json({ error: "올바르지 않은 성별입니다." });

    const user = req.hygoUser;
    user.name = String(name).trim();
    user.studentId = String(studentId).trim();
    user.department = String(department).trim();
    user.birthdate = String(birthdate).trim();
    user.phone = String(phone).trim();
    user.gender = gender;
    user.registered = true;
    persist();
    broadcast();
    res.json({ ok: true, user });
});

function validateApplicationPayload(body) {
    const { activityStyle, teamVibe, availability, weekendAvailability, frequency, activities, teammateRequest, comment } = body || {};

    if (!ACTIVITY_STYLE_OPTIONS.includes(activityStyle)) return { error: "활동 스타일을 선택해주세요." };
    if (!TEAM_VIBE_OPTIONS.includes(teamVibe)) return { error: "원하는 팀 분위기를 선택해주세요." };
    if (!WEEKEND_OPTIONS.includes(weekendAvailability)) return { error: "주말 가능 여부를 선택해주세요." };

    const freq = String(frequency || "").trim();
    if (!freq || freq.length > 60) return { error: "활동 빈도를 선택하거나 입력해주세요." };

    if (!Array.isArray(activities) || !activities.length) return { error: "선호 활동을 1개 이상 선택해주세요." };
    const cleanActivities = activities.map(a => String(a || "").trim()).filter(Boolean).slice(0, 30);
    if (!cleanActivities.length) return { error: "선호 활동을 1개 이상 선택해주세요." };

    const cleanAvailability = {};
    if (availability && typeof availability === "object") {
        APPLICATION_DAYS.forEach(day => {
            const slots = availability[day];
            if (Array.isArray(slots)) {
                const clean = slots.filter(s => APPLICATION_SLOTS.includes(s));
                if (clean.length) cleanAvailability[day] = clean;
            }
        });
    }
    if (!Object.keys(cleanAvailability).length) return { error: "가능한 시간을 1개 이상 선택해주세요." };

    return {
        value: {
            activityStyle, teamVibe,
            availability: cleanAvailability,
            weekendAvailability,
            frequency: freq,
            activities: cleanActivities,
            teammateRequest: String(teammateRequest || "").trim().slice(0, 30),
            comment: String(comment || "").trim().slice(0, 500),
        },
    };
}

app.post("/api/hygo/applications", requireLogin, (req, res) => {
    const user = req.hygoUser;
    if (!user.registered) return res.status(400).json({ error: "먼저 회원가입(인적사항 입력)을 완료해주세요." });
    const result = validateApplicationPayload(req.body);
    if (result.error) return res.status(400).json({ error: result.error });

    let application = data.applications.find(a => a.userId === user.id);
    if (application) {
        Object.assign(application, result.value);
        application.updatedAt = new Date().toISOString();
    } else {
        application = { id: uid(), userId: user.id, ...result.value, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
        data.applications.push(application);
    }
    persist();
    broadcast();
    res.json({ ok: true, application });
});

app.get("/api/hygo/applications/me", requireLogin, (req, res) => {
    const application = data.applications.find(a => a.userId === req.hygoUser.id);
    res.json({ application: application || null });
});

app.delete("/api/hygo/auth/withdraw", requireLogin, (req, res) => {
    data.users = data.users.filter(u => u.id !== req.hygoUser.id);
    data.applications = data.applications.filter(a => a.userId !== req.hygoUser.id);
    persist();
    broadcast();
    res.clearCookie("hygo_uid");
    res.json({ ok: true });
});

app.get("/api/hygo/admin/users", requireAdmin, (req, res) => {
    res.json({ users: data.users });
});

app.get("/api/hygo/admin/applications", requireAdmin, (req, res) => {
    res.json({ applications: data.applications });
});

app.put("/api/hygo/admin/users/:id", requireAdmin, (req, res) => {
    const user = data.users.find(u => u.id === req.params.id);
    if (!user) return res.status(404).json({ error: "사용자를 찾을 수 없습니다." });
    const { name, studentId, department, birthdate, phone, gender } = req.body || {};
    const fields = { name, studentId, department, birthdate, phone, gender };
    for (const v of Object.values(fields)) {
        if (!v || !String(v).trim()) return res.status(400).json({ error: "모든 항목을 입력해주세요." });
    }
    if (!GENDER_OPTIONS.includes(gender)) return res.status(400).json({ error: "올바르지 않은 성별입니다." });

    user.name = String(name).trim();
    user.studentId = String(studentId).trim();
    user.department = String(department).trim();
    user.birthdate = String(birthdate).trim();
    user.phone = String(phone).trim();
    user.gender = gender;
    persist();
    broadcast();
    res.json({ ok: true, user });
});

app.delete("/api/hygo/admin/users/:id", requireAdmin, (req, res) => {
    const exists = data.users.some(u => u.id === req.params.id);
    if (!exists) return res.status(404).json({ error: "사용자를 찾을 수 없습니다." });
    data.users = data.users.filter(u => u.id !== req.params.id);
    data.applications = data.applications.filter(a => a.userId !== req.params.id);
    persist();
    broadcast();
    res.json({ ok: true });
});

app.post("/api/hygo/admin/users/:id/team", requireAdmin, (req, res) => {
    const user = data.users.find(u => u.id === req.params.id);
    if (!user) return res.status(404).json({ error: "사용자를 찾을 수 없습니다." });
    const raw = (req.body || {}).teamId;
    const teamId = raw === null || raw === "" || raw === undefined ? null : Number(raw);
    if (teamId !== null) {
        const team = data.teams.find(t => t.id === teamId);
        if (!team) return res.status(400).json({ error: "올바르지 않은 팀입니다." });
    }
    user.teamId = teamId;
    persist();
    broadcast();
    res.json({ ok: true, user });
});

app.post("/api/hygo/submissions", requireLogin, async (req, res) => {
    const user = req.hygoUser;
    if (!user.registered) return res.status(400).json({ error: "먼저 회원가입(인적사항 입력)을 완료해주세요." });
    if (!user.teamId) return res.status(400).json({ error: "아직 조 배정이 완료되지 않았어요. 관리자에게 문의해주세요." });
    const { missionKey, participants, memo, photo } = req.body || {};
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

app.post("/api/hygo/admin/missions", requireAdmin, (req, res) => {
    const { key, category, label, emoji, points } = req.body || {};
    const cleanKey = String(key || "").trim();
    if (!cleanKey) return res.status(400).json({ error: "미션 키를 입력해주세요." });
    if (data.missions.some(m => m.key === cleanKey)) return res.status(400).json({ error: "이미 존재하는 미션 키입니다." });
    if (!MISSION_CATEGORIES.includes(category)) return res.status(400).json({ error: "올바르지 않은 카테고리입니다." });
    if (!String(label || "").trim()) return res.status(400).json({ error: "미션 이름을 입력해주세요." });

    const mission = {
        key: cleanKey, category, label: String(label).trim(), emoji: String(emoji || "🎯").trim(),
        points: Math.max(0, Number(points) || 0),
    };
    data.missions.push(mission);
    persist();
    broadcast();
    res.json({ ok: true, mission });
});

app.put("/api/hygo/admin/missions/:key", requireAdmin, (req, res) => {
    const mission = data.missions.find(m => m.key === req.params.key);
    if (!mission) return res.status(404).json({ error: "미션을 찾을 수 없습니다." });
    const { category, label, emoji, points } = req.body || {};

    if (category !== undefined) {
        if (!MISSION_CATEGORIES.includes(category)) return res.status(400).json({ error: "올바르지 않은 카테고리입니다." });
        mission.category = category;
    }
    if (label !== undefined) {
        if (!String(label).trim()) return res.status(400).json({ error: "미션 이름을 입력해주세요." });
        mission.label = String(label).trim();
    }
    if (emoji !== undefined && String(emoji).trim()) mission.emoji = String(emoji).trim();
    if (points !== undefined) mission.points = Math.max(0, Number(points) || 0);

    persist();
    broadcast();
    res.json({ ok: true, mission });
});

app.delete("/api/hygo/admin/missions/:key", requireAdmin, (req, res) => {
    if (!data.missions.some(m => m.key === req.params.key)) return res.status(404).json({ error: "미션을 찾을 수 없습니다." });
    if (data.missions.length <= 1) return res.status(400).json({ error: "최소 1개의 미션은 있어야 해요." });
    const hasPending = data.submissions.some(s => s.status === "pending" && s.missionKey === req.params.key);
    if (hasPending) return res.status(400).json({ error: "대기 중인 인증이 있는 미션은 삭제할 수 없어요. 먼저 승인/거절해주세요." });
    data.missions = data.missions.filter(m => m.key !== req.params.key);
    persist();
    broadcast();
    res.json({ ok: true });
});

app.post("/api/hygo/admin/activity-options", requireAdmin, (req, res) => {
    const name = String((req.body || {}).name || "").trim();
    if (!name) return res.status(400).json({ error: "활동 이름을 입력해주세요." });
    if (data.activityOptions.includes(name)) return res.status(400).json({ error: "이미 존재하는 활동입니다." });
    data.activityOptions.push(name);
    persist();
    broadcast();
    res.json({ ok: true, activityOptions: data.activityOptions });
});

app.put("/api/hygo/admin/activity-options/:name", requireAdmin, (req, res) => {
    const oldName = req.params.name;
    const idx = data.activityOptions.indexOf(oldName);
    if (idx === -1) return res.status(404).json({ error: "활동을 찾을 수 없습니다." });
    const newName = String((req.body || {}).name || "").trim();
    if (!newName) return res.status(400).json({ error: "활동 이름을 입력해주세요." });
    if (newName !== oldName && data.activityOptions.includes(newName)) return res.status(400).json({ error: "이미 존재하는 활동입니다." });
    data.activityOptions[idx] = newName;
    data.applications.forEach(a => {
        a.activities = a.activities.map(act => act === oldName ? newName : act);
    });
    persist();
    broadcast();
    res.json({ ok: true, activityOptions: data.activityOptions });
});

app.delete("/api/hygo/admin/activity-options/:name", requireAdmin, (req, res) => {
    const name = req.params.name;
    if (!data.activityOptions.includes(name)) return res.status(404).json({ error: "활동을 찾을 수 없습니다." });
    if (data.activityOptions.length <= 1) return res.status(400).json({ error: "최소 1개의 활동은 있어야 해요." });
    data.activityOptions = data.activityOptions.filter(a => a !== name);
    persist();
    broadcast();
    res.json({ ok: true, activityOptions: data.activityOptions });
});

// ---------- AI 자동배정 ----------
// 규칙 기반 그리디 클러스터링. 우선순위: 0) 서로가 서로를 지목한 짝, 1) 가능 시간 겹침,
// 2) 성별(팀마다 최대한 반반), 3) 팀 분위기(단, "엄청 열심히"↔"부담 없이"는 최대한 안 붙임),
// 4) 나이, 5) 학번 — 나이·학번은 서로 비슷한 사람끼리 묶는다.
// 그 외 주말 가능 여부·활동 빈도는 같은 사람끼리, 활동 스타일은 팀 안에서 고르게 섞이도록
// 보너스/페널티를 준다.
const TEAM_VIBE_EXTREMES = ["활동 엄청 열심히", "부담 없이"];
const FREQUENCY_ORDER = { "거의 매일": 3, "주 3~4회": 2, "주 1~2회": 1 };

function availabilityOverlap(a, b) {
    const days = new Set([...Object.keys(a.availability || {}), ...Object.keys(b.availability || {})]);
    let inter = 0, union = 0;
    days.forEach(day => {
        const setA = new Set((a.availability || {})[day] || []);
        const setB = new Set((b.availability || {})[day] || []);
        const all = new Set([...setA, ...setB]);
        all.forEach(slot => {
            union++;
            if (setA.has(slot) && setB.has(slot)) inter++;
        });
    });
    return union ? inter / union : 0;
}

function vibeCompatibility(a, b) {
    if (a.teamVibe === b.teamVibe) return 1;
    if (TEAM_VIBE_EXTREMES.includes(a.teamVibe) && TEAM_VIBE_EXTREMES.includes(b.teamVibe)) return -3;
    return 0;
}

function frequencyCloseness(a, b) {
    const sa = FREQUENCY_ORDER[a.frequency] ?? 1.5;
    const sb = FREQUENCY_ORDER[b.frequency] ?? 1.5;
    return 1 - Math.min(1, Math.abs(sa - sb) / 2);
}

function ageFromBirthdate(birthdate) {
    if (!birthdate) return null;
    const d = new Date(birthdate);
    if (Number.isNaN(d.getTime())) return null;
    return (Date.now() - d.getTime()) / (365.25 * 86400000);
}

function ageCloseness(a, b) {
    const ageA = ageFromBirthdate(a.birthdate);
    const ageB = ageFromBirthdate(b.birthdate);
    if (ageA == null || ageB == null) return 0;
    return 1 - Math.min(1, Math.abs(ageA - ageB) / 4);
}

// 학번은 보통 앞자리가 입학연도라서(예: 2021012345 → 2021), 그 4자리만 비교해 동기끼리 가깝게 묶는다.
function studentYear(studentId) {
    const prefix = String(studentId || "").slice(0, 4);
    return /^\d{4}$/.test(prefix) ? Number(prefix) : null;
}

function studentIdCloseness(a, b) {
    const ya = studentYear(a.studentId);
    const yb = studentYear(b.studentId);
    if (ya == null || yb == null) return 0;
    return 1 - Math.min(1, Math.abs(ya - yb) / 3);
}

// 성별은 "비슷한 사람끼리 묶기"가 아니라 "팀마다 최대한 반반"이 목표라서, 나머지 항목과 달리
// 팀에 이미 같은 성별이 많을수록 그 팀에 넣는 점수가 낮아지고, 부족할수록 높아진다.
function genderBalanceScore(gender, members) {
    if (!gender) return 0;
    let same = 0, other = 0;
    members.forEach(m => {
        if (!m.gender) return;
        if (m.gender === gender) same++; else other++;
    });
    const total = same + other;
    if (!total) return 0;
    // -1(이미 이 성별로 꽉 참) ~ +1(이 성별이 하나도 없어서 넣으면 균형에 좋음) 범위로 정규화한다.
    // 정규화 안 하면 팀 인원이 많아질수록 값이 커져서, 원래 최우선인 "팀 인원수 균형" 페널티(50점)를
    // 뒤엎어버리는 문제가 있었다.
    return (other - same) / total;
}

function runAutoAssign() {
    const appByUserId = new Map(data.applications.map(a => [a.userId, a]));
    const eligible = data.users.filter(u => u.registered && u.teamId == null && appByUserId.has(u.id));
    if (!eligible.length) return { assignedCount: 0, teamSizes: {} };

    // 신청서(선호 항목)와 회원 인적사항(성별/생년월일/학번)을 합쳐서 채점용 프로필을 만든다.
    function buildProfile(u) {
        const app = appByUserId.get(u.id) || {};
        return {
            userId: u.id, gender: u.gender, birthdate: u.birthdate, studentId: u.studentId,
            activityStyle: app.activityStyle, teamVibe: app.teamVibe, availability: app.availability,
            weekendAvailability: app.weekendAvailability, frequency: app.frequency,
        };
    }
    const profileByUserId = new Map(eligible.map(u => [u.id, buildProfile(u)]));

    const norm = s => String(s || "").trim().toLowerCase();
    const byName = new Map();
    eligible.forEach(u => {
        if (u.name) byName.set(norm(u.name), u.id);
    });

    // 0순위: 서로가 서로를 지목한 경우만 짝으로 묶는다 (한 명당 지목은 1명뿐이라 사이클은 생기지 않는다).
    const paired = new Set();
    const units = [];
    eligible.forEach(u => {
        if (paired.has(u.id)) return;
        const app = appByUserId.get(u.id);
        const reqName = norm(app.teammateRequest);
        if (!reqName) return;
        const targetId = byName.get(reqName);
        if (!targetId || targetId === u.id || paired.has(targetId)) return;
        const targetApp = appByUserId.get(targetId);
        const targetReq = norm(targetApp.teammateRequest);
        if (targetReq === norm(u.name)) {
            paired.add(u.id);
            paired.add(targetId);
            units.push({ userIds: [u.id, targetId] });
        }
    });
    eligible.forEach(u => { if (!paired.has(u.id)) units.push({ userIds: [u.id] }); });
    units.sort((a, b) => b.userIds.length - a.userIds.length);

    const teams = data.teams;
    const currentCount = new Map(teams.map(t => [t.id, data.users.filter(u => u.teamId === t.id).length]));
    const totalAfter = teams.reduce((sum, t) => sum + currentCount.get(t.id), 0) + eligible.length;
    const base = Math.floor(totalAfter / teams.length);
    const remainder = totalAfter % teams.length;
    const sortedByCount = [...teams].sort((a, b) => currentCount.get(a.id) - currentCount.get(b.id));
    const targetSize = new Map(teams.map(t => [t.id, base]));
    for (let i = 0; i < remainder; i++) targetSize.set(sortedByCount[i].id, targetSize.get(sortedByCount[i].id) + 1);

    // 이미 배정돼 있는 팀원은 신청서를 안 냈어도(수동 배정 등) 성별/나이/학번 균형 계산에는 포함한다.
    const teamMembers = new Map(teams.map(t => [
        t.id, data.users.filter(u => u.teamId === t.id).map(buildProfile),
    ]));
    const teamCount = new Map(teams.map(t => [t.id, currentCount.get(t.id)]));

    function scoreUnitForTeam(unitProfiles, teamId) {
        const members = teamMembers.get(teamId);
        let score = 0;

        unitProfiles.forEach(profile => {
            score += 20 * genderBalanceScore(profile.gender, members);
            if (!members.length) return;
            let avail = 0, vibe = 0, weekend = 0, freq = 0, sameStyle = 0, age = 0, sid = 0;
            members.forEach(m => {
                avail += availabilityOverlap(profile, m);
                vibe += vibeCompatibility(profile, m);
                weekend += profile.weekendAvailability === m.weekendAvailability ? 1 : 0;
                freq += frequencyCloseness(profile, m);
                sameStyle += profile.activityStyle === m.activityStyle ? 1 : 0;
                age += ageCloseness(profile, m);
                sid += studentIdCloseness(profile, m);
            });
            const n = members.length;
            score += 30 * (avail / n);
            score += 15 * (vibe / n);
            score += 12 * (age / n);
            score += 10 * (weekend / n);
            score += 8 * (sid / n);
            score += 8 * (freq / n);
            score += 5 * (1 - sameStyle / n);
        });
        return score;
    }

    units.forEach(unit => {
        const unitProfiles = unit.userIds.map(id => profileByUserId.get(id));
        // 팀 인원수 균형은 다른 항목들과 점수를 다투게 하지 않고 하드 제약으로 둔다: 목표 인원 안에
        // 들어갈 수 있는 팀이 하나라도 있으면 그 안에서만 고르고, 전부 꽉 찼을 때만 넘치는 걸 허용한다.
        const withinTarget = teams.filter(t => teamCount.get(t.id) + unitProfiles.length <= targetSize.get(t.id));
        const candidates = withinTarget.length ? withinTarget : teams;
        let best = candidates[0], bestScore = -Infinity;
        candidates.forEach(t => {
            const s = scoreUnitForTeam(unitProfiles, t.id);
            if (s > bestScore) { bestScore = s; best = t; }
        });
        unit.userIds.forEach(id => {
            data.users.find(u => u.id === id).teamId = best.id;
        });
        teamMembers.get(best.id).push(...unitProfiles);
        teamCount.set(best.id, teamCount.get(best.id) + unit.userIds.length);
    });

    return {
        assignedCount: eligible.length,
        teamSizes: Object.fromEntries(teams.map(t => [t.name, teamCount.get(t.id)])),
    };
}

app.post("/api/hygo/admin/auto-assign", requireAdmin, (req, res) => {
    if (data.teams.length < 1) return res.status(400).json({ error: "팀이 없습니다. 먼저 팀을 만들어주세요." });
    const result = runAutoAssign();
    if (result.assignedCount > 0) {
        persist();
        broadcast();
    }
    res.json({ ok: true, ...result });
});

app.post("/api/hygo/admin/test-bots", requireAdmin, (req, res) => {
    const count = Math.min(Math.max(Number((req.body || {}).count) || 12, 1), 60);
    const pick = arr => arr[Math.floor(Math.random() * arr.length)];
    const createdNicknames = [];
    const createdIds = [];

    for (let i = 0; i < count; i++) {
        const id = "bot_" + uid();
        const nickname = `테스트봇${Math.floor(1000 + Math.random() * 9000)}`;
        const admissionYear = 2019 + Math.floor(Math.random() * 6); // 2019~2024학번
        const birthYear = 2000 + Math.floor(Math.random() * 6); // 2000~2005년생
        const pad2 = n => String(n).padStart(2, "0");
        data.users.push({
            id, nickname, profileImage: "", teamId: null, registered: true, createdAt: new Date().toISOString(),
            name: `테스트회원${i + 1}`, studentId: `${admissionYear}${String(100000 + i).padStart(6, "0")}`, department: "테스트학과",
            birthdate: `${birthYear}-${pad2(1 + Math.floor(Math.random() * 12))}-${pad2(1 + Math.floor(Math.random() * 28))}`,
            phone: "010-0000-0000", gender: pick(GENDER_OPTIONS),
        });

        const availability = {};
        APPLICATION_DAYS.forEach(day => {
            if (Math.random() < 0.7) {
                const slots = APPLICATION_SLOTS.filter(() => Math.random() < 0.35);
                if (slots.length) availability[day] = slots;
            }
        });
        const activities = data.activityOptions.filter(() => Math.random() < 0.25);

        data.applications.push({
            id: uid(), userId: id,
            activityStyle: pick(ACTIVITY_STYLE_OPTIONS),
            teamVibe: pick(TEAM_VIBE_OPTIONS),
            availability,
            weekendAvailability: pick(WEEKEND_OPTIONS),
            frequency: pick(FREQUENCY_OPTIONS),
            activities: activities.length ? activities : [pick(data.activityOptions)],
            teammateRequest: "",
            comment: "",
            createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        });
        createdNicknames.push(nickname);
        createdIds.push(id);
    }

    // 테스트용으로 짝 지목(0순위) 로직도 검증할 수 있도록, 봇 중 한 쌍은 서로를 지목하게 만든다.
    if (createdIds.length >= 2) {
        const [aId, bId] = createdIds;
        const aApp = data.applications.find(a => a.userId === aId);
        const bApp = data.applications.find(a => a.userId === bId);
        const aUser = data.users.find(u => u.id === aId);
        const bUser = data.users.find(u => u.id === bId);
        aApp.teammateRequest = bUser.name;
        bApp.teammateRequest = aUser.name;
    }

    persist();
    broadcast();
    res.json({ ok: true, created: createdNicknames.length, nicknames: createdNicknames });
});

app.delete("/api/hygo/admin/test-bots", requireAdmin, (req, res) => {
    const botIds = new Set(data.users.filter(u => u.id.startsWith("bot_")).map(u => u.id));
    if (!botIds.size) return res.json({ ok: true, removed: 0 });
    data.users = data.users.filter(u => !botIds.has(u.id));
    data.applications = data.applications.filter(a => !botIds.has(a.userId));
    persist();
    broadcast();
    res.json({ ok: true, removed: botIds.size });
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
    // 초기화 전에 관리자가 팀을 추가했었다면(9번 팀 이상), 그 팀 소속이던 사람들의 teamId가
    // 방금 새로 만든 기본 8팀 어디에도 없는 값으로 붕 뜬 채 남는다 — 미배정으로 되돌린다.
    const validTeamIds = new Set(data.teams.map(t => t.id));
    data.users.forEach(u => { if (u.teamId != null && !validTeamIds.has(u.teamId)) u.teamId = null; });
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

    data = normalizeCampaign({
        teams: incoming.teams.map(t => ({ ...t, points: Number(t.points) || 0, missionsCount: Number(t.missionsCount) || 0 })),
        submissions: importedSubmissions,
        adjustments: incoming.adjustments,
        nextTeamId: incoming.nextTeamId || (Math.max(0, ...incoming.teams.map(t => t.id)) + 1),
        campaign: incoming.campaign,
        users: incoming.users,
        missions: incoming.missions,
        applications: incoming.applications,
        activityOptions: incoming.activityOptions,
    });
    persist();
    broadcast();
    res.json({ ok: true });

    for (const sub of oldSubmissions) {
        if (isStoredPhotoRef(sub.photo)) await deletePhoto(photoRefId(sub.photo));
    }
});

// 예상 못한 비동기 에러 하나 때문에 서버 전체가 죽는 것을 막는 최후의 안전망.
// (예: fire-and-forget로 호출한 어딘가에서 처리 안 된 예외가 나는 경우)
process.on("unhandledRejection", err => {
    console.error("[hygo] unhandled promise rejection (server kept running):", err);
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
