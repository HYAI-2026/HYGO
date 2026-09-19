// HY-GO 네트워킹 프로그램 — 독립 서버.
// 메인 프로젝트(server.js, Project LIFE 게임)와는 완전히 분리된 별도 앱이다.
// 실행: node hygo/server.js  (포트는 HYGO_PORT, 기본 4000)

require("dotenv").config();
const fs = require("fs");
const path = require("path");
const http = require("http");
const express = require("express");
const cookieParser = require("cookie-parser");
const webpush = require("web-push");
const { Server: SocketIOServer } = require("socket.io");

const ADMIN_PASSWORD = process.env.HYGO_ADMIN_PASSWORD || "hyai0926";
const DAILY_CASUAL_CAP = 15;
const DATA_PATH = path.join(__dirname, "data", "hygo-data.json");
const DEFAULT_CAMPAIGN = { start: "2026-09-21", end: "2026-10-30" };
const WEBHOOK_URL = process.env.HYGO_WEBHOOK_URL || "";

// ---------- 웹 푸시 알림 ----------
// VAPID 키는 환경변수로 직접 지정할 수도 있고, 지정 안 하면 최초 실행 시 한 번 만들어서
// data(=Redis/파일)에 저장해두고 계속 재사용한다 — 재시작마다 키가 바뀌면 그동안 모은 구독이
// 전부 무효가 되기 때문이다.
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || "mailto:hyai.hanyang@gmail.com";
let VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || "";
let VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || "";

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

// ---------- 자동 백업 (매일 1회, 가벼운 스냅샷) ----------
// 팀 초기화 버튼("전체 0점으로 초기화", "샘플 데이터로 초기화")은 더 이상 인증 사진을 지우지
// 않기 때문에(아래 reset 라우트들 참고), 매일 백업은 사진 URL만 가리키는 가벼운 스냅샷이면
// 충분하다 — 사진 자체는 어차피 안 지워지고 그대로 살아있으니까. 덕분에 한 달 넘는 행사 기간
// 전체를 매일치 하나도 안 버리고 다 보관해도 Upstash 무료 저장 용량에 무리가 없다.
const BACKUPS_DIR = path.join(__dirname, "data", "backups");
const BACKUP_RETENTION_DAYS = 90; // 넉넉하게 3개월치 — 한 학기짜리 행사도 통째로 다 남는다.
const backupRedisKey = date => `hygo:backup:${date}`;

async function saveBackupSnapshot(date, snapshot) {
    const body = JSON.stringify(snapshot);
    if (REDIS_ENABLED) {
        const res = await fetch(`${REDIS_URL}/set/${backupRedisKey(date)}`, {
            method: "POST",
            headers: { Authorization: `Bearer ${REDIS_TOKEN}`, "Content-Type": "text/plain" },
            body,
        });
        if (!res.ok) throw new Error(`Upstash backup SET failed (${res.status})`);
        return;
    }
    fs.mkdirSync(BACKUPS_DIR, { recursive: true });
    await fs.promises.writeFile(path.join(BACKUPS_DIR, `${date}.json`), body, "utf-8");
}

async function loadBackupSnapshot(date) {
    if (REDIS_ENABLED) {
        const res = await fetch(`${REDIS_URL}/get/${backupRedisKey(date)}`, {
            headers: { Authorization: `Bearer ${REDIS_TOKEN}` },
        });
        if (!res.ok) throw new Error(`Upstash backup GET failed (${res.status})`);
        const json = await res.json();
        return json.result ? JSON.parse(json.result) : null;
    }
    const p = path.join(BACKUPS_DIR, `${date}.json`);
    if (!fs.existsSync(p)) return null;
    return JSON.parse(await fs.promises.readFile(p, "utf-8"));
}

async function deleteBackupSnapshot(date) {
    try {
        if (REDIS_ENABLED) {
            await fetch(`${REDIS_URL}/del/${backupRedisKey(date)}`, {
                method: "POST",
                headers: { Authorization: `Bearer ${REDIS_TOKEN}` },
            });
        } else {
            const p = path.join(BACKUPS_DIR, `${date}.json`);
            if (fs.existsSync(p)) await fs.promises.unlink(p);
        }
    } catch (e) {
        console.warn(`[hygo] failed to delete backup ${date}:`, e.message);
    }
}

// 사진 URL만 가리키는 스냅샷을, 사진 데이터를 실제로 채운 완전한 형태로 바꾼다 — 이렇게 만든
// 파일은 Upstash가 통째로 사라져도(=사진 파일도 같이 사라짐) 그 자체만으로 완전히 복구 가능하다.
async function resolvePhotos(snapshot) {
    for (const sub of snapshot.submissions) {
        if (isStoredPhotoRef(sub.photo)) {
            const real = await loadPhoto(photoRefId(sub.photo));
            if (real) sub.photo = real;
        }
    }
    return snapshot;
}

// 지금 이 순간의 라이브 데이터를 완전한 스냅샷으로 만든다 — 수동 "백업 다운로드"(GET /api/hygo/export)가 쓴다.
async function buildFullExport() {
    return resolvePhotos(JSON.parse(JSON.stringify(data)));
}

// Render 무료 플랜은 요청이 없으면 서버가 잠들어서, 특정 시각에 맞춰 도는 타이머로는 백업이
// 안정적으로 실행된다고 보장할 수 없다. 그래서 "마지막 백업 후 23시간이 지났으면 지금 백업한다"를
// 서버가 깨어있는 동안 주기적으로(30분마다) 체크하는 방식으로 만들었다 — 하루 중 언제든 트래픽이
// 한 번만 있어도(=서버가 깨어있으면) 그날의 백업이 이뤄진다.
async function runDailyBackupIfDue(force) {
    const last = data.lastBackupAt ? new Date(data.lastBackupAt).getTime() : 0;
    if (!force && Date.now() - last < 23 * 60 * 60 * 1000) return { skipped: true };

    const date = todayKey(new Date().toISOString());
    let entry;
    try {
        // 사진은 초기화 버튼이 더 이상 지우지 않으니(위 reset 라우트들 참고), 매일 백업할 때마다
        // 사진까지 통째로 복사할 필요가 없다 — 사진 URL만 가리키는 가벼운 스냅샷으로 충분하고,
        // 덕분에 행사 기간 내내 매일치를 다 보관해도 용량 걱정이 없다. 수동 "백업 다운로드"
        // (컴퓨터에 파일로 저장하는 것)만 사진을 실제로 채운 완전한 형태를 유지한다.
        const snapshot = JSON.parse(JSON.stringify(data));
        await saveBackupSnapshot(date, snapshot);
        entry = { date, createdAt: new Date().toISOString(), ok: true };
        console.log(`[hygo] daily backup saved: ${date}`);
    } catch (e) {
        entry = { date, createdAt: new Date().toISOString(), ok: false, error: e.message };
        console.warn("[hygo] daily backup failed:", e.message);
    }

    if (!Array.isArray(data.backups)) data.backups = [];
    data.backups = data.backups.filter(b => b.date !== date);
    data.backups.push(entry);
    data.backups.sort((a, b) => a.date.localeCompare(b.date));
    while (data.backups.length > BACKUP_RETENTION_DAYS) {
        const old = data.backups.shift();
        await deleteBackupSnapshot(old.date);
    }
    data.lastBackupAt = new Date().toISOString();
    persist();
    return { entry };
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

// 특정 유저에게 웹 푸시 알림을 보낸다. 구독이 만료/취소된 경우(404, 410) 목록에서 제거한다.
async function sendPushToUser(userId, payload) {
    const subs = (data.pushSubscriptions || []).filter(s => s.userId === userId);
    if (!subs.length) return;
    const body = JSON.stringify(payload);
    let changed = false;
    await Promise.all(subs.map(async (s) => {
        try {
            await webpush.sendNotification(s.subscription, body);
        } catch (e) {
            if (e.statusCode === 404 || e.statusCode === 410) {
                data.pushSubscriptions = data.pushSubscriptions.filter(x => x.subscription.endpoint !== s.subscription.endpoint);
                changed = true;
            } else {
                console.warn("[hygo] push send failed:", e.message);
            }
        }
    }));
    if (changed) persist();
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
        teams, submissions, adjustments, campaign: { ...DEFAULT_CAMPAIGN }, users: [],
        missions: DEFAULT_MISSIONS.map(m => ({ ...m })),
        applications: [], activityOptions: DEFAULT_ACTIVITY_OPTIONS.slice(), applicationDeadline: null,
        pushSubscriptions: [], vapidKeys: null,
        backups: [], lastBackupAt: null,
        autoAssignConfig: { excludedNames: [], fixedGroups: [], separationPairs: [] },
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
    if (!Array.isArray(parsed.activityOptions) || !parsed.activityOptions.length) parsed.activityOptions = DEFAULT_ACTIVITY_OPTIONS.slice();
    if (parsed.applicationDeadline === undefined) parsed.applicationDeadline = null;
    if (!Array.isArray(parsed.pushSubscriptions)) parsed.pushSubscriptions = [];
    if (parsed.vapidKeys === undefined) parsed.vapidKeys = null;
    if (!Array.isArray(parsed.backups)) parsed.backups = [];
    if (parsed.lastBackupAt === undefined) parsed.lastBackupAt = null;
    if (!parsed.autoAssignConfig || typeof parsed.autoAssignConfig !== "object") {
        parsed.autoAssignConfig = { excludedNames: [], fixedGroups: [], separationPairs: [] };
    }
    if (!Array.isArray(parsed.autoAssignConfig.excludedNames)) parsed.autoAssignConfig.excludedNames = [];
    if (!Array.isArray(parsed.autoAssignConfig.fixedGroups)) parsed.autoAssignConfig.fixedGroups = [];
    if (!Array.isArray(parsed.autoAssignConfig.separationPairs)) parsed.autoAssignConfig.separationPairs = [];
    if (Array.isArray(parsed.submissions)) {
        parsed.submissions.forEach(s => {
            if (!Array.isArray(s.comments)) s.comments = [];
            s.comments.forEach(c => { if (typeof c.reported !== "boolean") c.reported = false; });
            if (!s.reactedBy || typeof s.reactedBy !== "object") s.reactedBy = {};
            if (!s.reactions || typeof s.reactions !== "object") s.reactions = emptyReactions();
            REACTION_TYPES.forEach(key => { if (typeof s.reactions[key] !== "number") s.reactions[key] = 0; });
            if (!Array.isArray(s.participantList)) s.participantList = [];
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

// 탈퇴 등으로 사용자가 사라졌는데 신청서만 남아있는 경우, 집계/조회에서만 제외한다.
// (예전엔 서버가 새로 켜질 때마다 이 조건으로 data.applications 자체를 지워버렸는데,
//  id 타입이 어쩌다 안 맞는 등의 이유로 멀쩡한 신청서까지 통째로 날아가는 사고로 이어질 수 있어서
//  원본 데이터는 절대 건드리지 않고 보여줄 때만 걸러내는 방식으로 바꿨다.)
function liveApplications() {
    const existingUserIds = new Set(data.users.map(u => String(u.id)));
    return data.applications.filter(a => existingUserIds.has(String(a.userId)));
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
    if (data.applicationDeadline && Date.now() > new Date(data.applicationDeadline).getTime()) {
        return res.status(400).json({ error: "신청서 접수가 마감됐어요." });
    }
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

// 미션 인증 제출 시 "참여 인원"을 이름으로 직접 고를 수 있도록, 같은 팀원 명단(이름만)을 내려준다.
// 같이 미션을 수행한 사람들끼리는 어차피 서로 이름을 아는 사이라 팀 범위로 한정해서 공개해도 괜찮다.
app.get("/api/hygo/team/mine/members", requireLogin, (req, res) => {
    const user = req.hygoUser;
    if (!user.teamId) return res.json({ members: [] });
    const members = data.users
        .filter(u => u.teamId === user.teamId && u.registered)
        .map(u => ({ id: u.id, name: u.name }));
    res.json({ members });
});

app.delete("/api/hygo/auth/withdraw", requireLogin, (req, res) => {
    data.users = data.users.filter(u => u.id !== req.hygoUser.id);
    data.applications = data.applications.filter(a => a.userId !== req.hygoUser.id);
    data.pushSubscriptions = (data.pushSubscriptions || []).filter(s => s.userId !== req.hygoUser.id);
    persist();
    broadcast();
    res.clearCookie("hygo_uid");
    res.json({ ok: true });
});

app.get("/api/hygo/admin/users", requireAdmin, (req, res) => {
    res.json({ users: data.users });
});

app.get("/api/hygo/admin/applications", requireAdmin, (req, res) => {
    res.json({ applications: liveApplications() });
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
    data.pushSubscriptions = (data.pushSubscriptions || []).filter(s => s.userId !== req.params.id);
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
    const { missionKey, participantIds, memo, photo } = req.body || {};
    const mission = missionByKey(missionKey);
    const team = data.teams.find(t => t.id === user.teamId);

    if (!mission) return res.status(400).json({ error: "올바르지 않은 미션 유형입니다." });
    if (!team) return res.status(400).json({ error: "소속 팀을 찾을 수 없습니다. 팀을 다시 선택해주세요." });
    if (mission.category === "돌발") {
        const already = data.submissions.some(s =>
            s.teamId === team.id && s.missionKey === mission.key && (s.status === "pending" || s.status === "approved"));
        if (already) return res.status(400).json({ error: "이미 진행했거나 진행 중인 돌발 미션이에요. 돌발 미션은 팀당 1번만 수행할 수 있어요." });
    } else {
        // 일상 미션은 "같은 미션 종류"를 팀당 하루 1번만 인증할 수 있다(다른 종류는 같은 날에 여러 개 가능).
        const today = todayKey(new Date().toISOString());
        const alreadyToday = data.submissions.some(s =>
            s.teamId === team.id && s.missionKey === mission.key && todayKey(s.createdAt) === today &&
            (s.status === "pending" || s.status === "approved"));
        if (alreadyToday) return res.status(400).json({ error: `오늘은 이미 "${mission.label}" 미션을 인증했어요. 같은 미션은 하루에 한 번만 인증할 수 있어요.` });
    }
    // 참여 인원은 숫자로 직접 입력받는 대신, 실제로 우리 팀에 있는 사람 중에서 골라야 한다
    // (엉뚱한 사람 이름을 적어내는 걸 막고, 나중에 개인별 기여 점수를 정확히 계산하기 위함).
    const teamMembers = data.users.filter(u => u.teamId === team.id && u.registered);
    const teamMemberIds = new Set(teamMembers.map(u => u.id));
    const chosenIds = Array.isArray(participantIds) ? [...new Set(participantIds.map(String))].filter(pid => teamMemberIds.has(pid)) : [];
    if (chosenIds.length < 3) {
        return res.status(400).json({ error: "참여 인원은 우리 팀원 중 최소 3명 이상 선택해주세요." });
    }
    const participantList = chosenIds.map(pid => {
        const u = teamMembers.find(x => x.id === pid);
        return { id: u.id, name: u.name };
    });
    if (!memo || !String(memo).trim()) return res.status(400).json({ error: "한 줄 메모를 입력해주세요." });
    if (!photo || !String(photo).startsWith("data:image/")) {
        return res.status(400).json({ error: "인증 사진을 업로드해주세요." });
    }

    const id = uid();
    const sub = {
        id, teamId: team.id, missionKey: mission.key, category: mission.category,
        label: mission.label, emoji: mission.emoji, participants: participantList.length, participantList,
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

    // 팀원 전원이 참여한 미션은 +3점 보너스가 따로 붙는다(인증샷 찍기는 제외). "최대 점수 제한 없음"
    // 규칙이라 하루 15점 상한(위의 remaining 계산) 밖에서 별도로 더한다.
    const teamMemberCount = data.users.filter(u => u.teamId === team.id && u.registered).length;
    const fullTeamBonus = (mission.key !== "photo" && teamMemberCount > 0 &&
        Array.isArray(sub.participantList) && sub.participantList.length === teamMemberCount) ? 3 : 0;
    award += fullTeamBonus;

    sub.status = "approved";
    sub.approvedAt = new Date().toISOString();
    sub.awardedPoints = award;
    sub.fullTeamBonus = fullTeamBonus;
    team.points += award;
    team.missionsCount += 1;

    persist();
    broadcast();
    if (sub.authorId) {
        sendPushToUser(sub.authorId, {
            title: "✅ 인증이 승인됐어요",
            body: `${mission.emoji} ${mission.label} · +${award}점`,
            url: "/",
        });
    }
    res.json({ ok: true, awardedPoints: award, capApplied, fullTeamBonus, teamName: team.name });
});

app.post("/api/hygo/submissions/:id/reject", requireAdmin, (req, res) => {
    const sub = data.submissions.find(s => s.id === req.params.id);
    if (!sub || sub.status !== "pending") return res.status(404).json({ error: "대기 중인 인증을 찾을 수 없습니다." });
    sub.status = "rejected";
    sub.rejectedAt = new Date().toISOString();
    sub.rejectionReason = ((req.body || {}).reason || "").trim();
    persist();
    broadcast();
    if (sub.authorId) {
        sendPushToUser(sub.authorId, {
            title: "❌ 인증이 거절됐어요",
            body: sub.rejectionReason ? `${sub.emoji} ${sub.label} · ${sub.rejectionReason}` : `${sub.emoji} ${sub.label}`,
            url: "/",
        });
    }
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
    if (sub.authorId && sub.authorId !== user.id) {
        sendPushToUser(sub.authorId, {
            title: "💬 댓글이 달렸어요",
            body: `${sub.emoji} ${sub.label} · "${comment.text}"`,
            url: "/",
        });
    }
    res.json({ ok: true, comment });
});

app.get("/api/hygo/push/vapid-public-key", (req, res) => {
    res.json({ publicKey: VAPID_PUBLIC_KEY });
});

app.post("/api/hygo/push/subscribe", requireLogin, (req, res) => {
    const user = req.hygoUser;
    const subscription = (req.body || {}).subscription;
    if (!subscription || !subscription.endpoint) {
        return res.status(400).json({ error: "올바르지 않은 구독 정보입니다." });
    }
    if (!Array.isArray(data.pushSubscriptions)) data.pushSubscriptions = [];
    data.pushSubscriptions = data.pushSubscriptions.filter(s => s.subscription.endpoint !== subscription.endpoint);
    data.pushSubscriptions.push({ userId: user.id, subscription, createdAt: new Date().toISOString() });
    persist();
    res.json({ ok: true });
});

app.post("/api/hygo/push/unsubscribe", requireLogin, (req, res) => {
    const endpoint = (req.body || {}).endpoint;
    if (!endpoint) return res.status(400).json({ error: "올바르지 않은 요청입니다." });
    data.pushSubscriptions = (data.pushSubscriptions || []).filter(s => s.subscription.endpoint !== endpoint);
    persist();
    res.json({ ok: true });
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

// 팀 번호는 계속 증가하기만 하는 카운터가 아니라, 지금 안 쓰이는 가장 작은 번호를 매번 다시
// 찾아서 준다 — 안 그러면 예를 들어 8팀을 지우고 다시 추가했을 때 8팀이 아니라 9팀이 되고,
// 팀은 8개인데 번호는 계속 늘어나기만 하는 문제가 생긴다.
function nextAvailableTeamId() {
    const used = new Set(data.teams.map(t => t.id));
    let id = 1;
    while (used.has(id)) id++;
    return id;
}

app.post("/api/hygo/teams", requireAdmin, (req, res) => {
    const name = ((req.body || {}).name || "").trim();
    const id = nextAvailableTeamId();
    const team = { id, name: name || `${id}팀`, points: 0, missionsCount: 0 };
    data.teams.push(team);
    persist();
    broadcast();
    res.json({ ok: true, team });
});

app.put("/api/hygo/teams/:id", requireAdmin, (req, res) => {
    const team = data.teams.find(t => t.id === Number(req.params.id));
    if (!team) return res.status(404).json({ error: "팀을 찾을 수 없습니다." });
    const name = ((req.body || {}).name || "").trim();
    if (!name) return res.status(400).json({ error: "팀 이름을 입력해주세요." });
    team.name = name;
    persist();
    broadcast();
    res.json({ ok: true, team });
});

// 팀은 그대로 두고(이름/점수/미션 기록 유지) 소속 팀원들만 전부 미배정 상태로 되돌린다 —
// 예를 들어 자동배정 결과가 마음에 안 들어서 특정 조를 통째로 다시 짜고 싶을 때 쓴다.
app.post("/api/hygo/teams/:id/unassign-all", requireAdmin, (req, res) => {
    const teamId = Number(req.params.id);
    const team = data.teams.find(t => t.id === teamId);
    if (!team) return res.status(404).json({ error: "팀을 찾을 수 없습니다." });
    const affected = data.users.filter(u => u.teamId === teamId);
    affected.forEach(u => { u.teamId = null; });
    persist();
    broadcast();
    res.json({ ok: true, count: affected.length });
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

app.post("/api/hygo/admin/application-deadline", requireAdmin, (req, res) => {
    const raw = (req.body || {}).deadline;
    if (raw === null || raw === "") {
        data.applicationDeadline = null;
    } else {
        const d = new Date(raw);
        if (Number.isNaN(d.getTime())) return res.status(400).json({ error: "날짜 형식이 올바르지 않습니다." });
        data.applicationDeadline = d.toISOString();
    }
    persist();
    broadcast();
    res.json({ ok: true, applicationDeadline: data.applicationDeadline });
});

// ---------- AI 자동배정 (시뮬레이티드 어닐링) ----------
// "정답을 계산"하는 대신 "팀 하나의 점수를 매기는 함수"를 정의해두고, 그 점수 합을 최대화하는
// 배정을 담금질 기법(simulated annealing)으로 탐색한다. 조건을 더 넣고 싶으면 scoreTeam에
// 항목만 추가하면 된다. 이미 팀 배정된 사람은 건드리지 않고(수동 배정 유지), 아직 배정 안 된
// 사람만 탐색 대상으로 삼는 건 기존과 동일하다.
//
// 하드 제약(절대 안 어김):
//   - 신청서에서 서로 지목했거나(상호 지목만 반영 — 한쪽만 적으면 무시) 관리자가 지정한 고정
//     그룹이든, "반드시 같은 팀"인 사람들은 유닛(하나의 배정 단위)으로 묶어서 탐색 공간 자체에서
//     분리를 불가능하게 만든다.
//   - 성별 — 팀마다 "이 성별은 정확히 N명"을 전체 성비에 비례해서 미리 정해두고 못 넘게 막는다.
//     예전에 실제로 한쪽 성별에 쏠리는 문제가 있어서 하드 제약으로 만든 부분이라 계속 유지한다.
//   - 팀 인원수 — 목표 인원(팀 수만큼 고르게 분배) 안에서만 채운다.
// 소프트 점수(높을수록 좋은 배정, 담금질로 최대화):
//   - 3명 이상 모일 수 있는 시간대 수(이 앱 미션 규칙의 "최소 3명"과 맞춤), 요일 커버리지,
//     팀 전원이 다 되는 시간대, 주말 가능 인원
//   - 개인이 소외되지 않는지(내가 갈 수 있는 시간대에 사람이 충분히 모이는지)
//   - 활동 빈도(고빈도 인원이 한 팀에 몰리지 않게), 성향(외향/조용/열심히형 쏠림 방지), 학과 다양성
//   - 관리자가 지정한 "분리 조건"(같은 팀이면 큰 감점)
// "하고 싶은 활동"과 "기타 의견"은 자유 서술이라 점수에 안 쓴다.
const FREQUENCY_SCORE = { "거의 매일": 4, "주 3~4회": 3, "주 1~2회": 1 };
const ALL_SLOT_KEYS = APPLICATION_DAYS.flatMap(day => APPLICATION_SLOTS.map(slot => day + slot));

// 학번은 보통 앞자리가 입학연도라서(예: 2021012345 → 2021) — 점수엔 안 쓰지만 진단 정보용으로 남겨둔다.
function studentYear(studentId) {
    const prefix = String(studentId || "").slice(0, 4);
    return /^\d{4}$/.test(prefix) ? Number(prefix) : null;
}

// "반드시 같은 팀" 관계를 유닛(연결 성분)으로 묶기 위한 간단한 Union-Find.
class UnionFind {
    constructor(ids) { this.parent = new Map(ids.map(id => [id, id])); }
    find(x) {
        while (this.parent.get(x) !== x) { this.parent.set(x, this.parent.get(this.parent.get(x))); x = this.parent.get(x); }
        return x;
    }
    union(a, b) { const ra = this.find(a), rb = this.find(b); if (ra !== rb) this.parent.set(ra, rb); }
}

function runAutoAssign() {
    const appByUserId = new Map(data.applications.map(a => [a.userId, a]));
    const config = data.autoAssignConfig || { excludedNames: [], fixedGroups: [], separationPairs: [] };
    const norm = s => String(s || "").trim().toLowerCase();
    const byName = new Map();
    data.users.forEach(u => { if (u.name) byName.set(norm(u.name), u.id); });
    const resolveName = name => byName.get(norm(name));

    const excludedIds = new Set((config.excludedNames || []).map(resolveName).filter(Boolean));
    const unresolved = (config.excludedNames || []).filter(n => !resolveName(n));

    const eligible = data.users.filter(u => u.registered && u.teamId == null && appByUserId.has(u.id) && !excludedIds.has(u.id));
    if (!eligible.length) {
        return {
            assignedCount: 0, teamSizes: {},
            warnings: unresolved.length ? [`제외자 목록에서 찾을 수 없는 이름: ${unresolved.join(", ")}`] : [],
        };
    }

    // 신청서(선호 항목)와 회원 인적사항을 합쳐서, 점수 계산에 바로 쓸 수 있는 형태로 미리 변환해둔다
    // (담금질이 같은 사람을 수만 번 다시 채점하므로, 매번 원본에서 다시 계산하지 않도록).
    function buildProfile(u) {
        const app = appByUserId.get(u.id) || {};
        const availability = app.availability || {};
        const slots = new Set();
        APPLICATION_DAYS.forEach(day => (availability[day] || []).forEach(slot => slots.add(day + slot)));
        const weekend = app.weekendAvailability || "";
        const style = app.activityStyle || "";
        return {
            userId: u.id, name: u.name, gender: u.gender, studentId: u.studentId,
            dept: String(u.department || "").slice(0, 3), // 표기 흔들림(학과 뒤 "학과"/"과" 등)을 앞 3글자로 흡수
            slots,
            sat: weekend.includes("토"), sun: weekend.includes("일"),
            freq: FREQUENCY_SCORE[app.frequency] || 0,
            outgoing: style.startsWith("새로운"), quiet: style.startsWith("조용"),
            hard: String(app.teamVibe || "").includes("열심히"),
        };
    }
    const profileByUserId = new Map(eligible.map(u => [u.id, buildProfile(u)]));

    // ---- 유닛 만들기: 지목 요청(상호 지목만 반영) + 관리자 고정 그룹을 Union-Find로 묶는다 ----
    const uf = new UnionFind(eligible.map(u => u.id));
    eligible.forEach(u => {
        const targetId = resolveName((appByUserId.get(u.id) || {}).teammateRequest);
        if (!targetId || targetId === u.id || !profileByUserId.has(targetId)) return;
        const targetBackId = resolveName((appByUserId.get(targetId) || {}).teammateRequest);
        if (targetBackId === u.id) uf.union(u.id, targetId); // 서로 지목했을 때만 묶는다
    });
    const configWarnings = [];
    (config.fixedGroups || []).forEach(group => {
        const validIds = [];
        const missing = [];
        group.forEach(n => {
            const id = resolveName(n);
            if (id && profileByUserId.has(id)) validIds.push(id); else missing.push(n);
        });
        if (missing.length) configWarnings.push(`고정 그룹 중 지금 배정 대상이 아니라 제외된 사람: ${missing.join(", ")}`);
        for (let i = 1; i < validIds.length; i++) uf.union(validIds[0], validIds[i]);
    });
    const groupMap = new Map();
    eligible.forEach(u => {
        const root = uf.find(u.id);
        if (!groupMap.has(root)) groupMap.set(root, []);
        groupMap.get(root).push(u.id);
    });
    const units = [...groupMap.values()].map(userIds => ({ userIds }));

    // ---- 분리 조건: 이름 -> id, 못 찾으면 경고만 남기고 무시 ----
    const separationPairs = [];
    (config.separationPairs || []).forEach(pair => {
        const [a, b] = pair || [];
        const ida = resolveName(a), idb = resolveName(b);
        if (ida && idb) separationPairs.push([ida, idb]);
        else configWarnings.push(`분리 조건 중 찾을 수 없는 이름: ${[a, b].filter(n => !resolveName(n)).join(", ")}`);
    });

    // ---- 팀 목표 인원수 (기존과 동일: 기본값 + 나머지는 부족한 팀부터 1명씩) ----
    const teams = data.teams;
    const currentCount = new Map(teams.map(t => [t.id, data.users.filter(u => u.teamId === t.id).length]));
    const totalAfter = teams.reduce((sum, t) => sum + currentCount.get(t.id), 0) + eligible.length;
    const base = Math.floor(totalAfter / teams.length);
    const remainder = totalAfter % teams.length;
    const sortedByCount = [...teams].sort((a, b) => currentCount.get(a.id) - currentCount.get(b.id));
    const targetSize = new Map(teams.map(t => [t.id, base]));
    for (let i = 0; i < remainder; i++) targetSize.set(sortedByCount[i].id, targetSize.get(sortedByCount[i].id) + 1);

    // 고정 그룹(유닛)이 어느 팀 목표 인원보다도 크면 애초에 들어갈 자리가 없다 — 실행 전에 걸러서 알려준다.
    const maxTargetSize = Math.max(0, ...teams.map(t => targetSize.get(t.id)));
    const oversized = units.filter(u => u.userIds.length > maxTargetSize);
    if (oversized.length) {
        return {
            assignedCount: 0, teamSizes: {},
            error: `묶인 인원이 팀 목표 인원(최대 ${maxTargetSize}명)보다 많은 그룹이 있어요: ` +
                oversized.map(u => u.userIds.map(id => profileByUserId.get(id).name).join("+")).join(" / "),
        };
    }

    // 이미 배정된 팀원(수동 배정 등)은 탐색 대상이 아니라 고정값으로 취급하되, 팀 점수 계산에는 포함한다.
    const fixedMembersByTeam = new Map(teams.map(t => [t.id, data.users.filter(u => u.teamId === t.id).map(buildProfile)]));

    // ---- 성별 목표 인원 (기존 하드 제약 로직 그대로 유지 — 실제로 쏠림을 막아준 부분) ----
    const allProfilesForGender = [...teams.flatMap(t => fixedMembersByTeam.get(t.id)), ...eligible.map(u => profileByUserId.get(u.id))];
    const genderTotals = {};
    allProfilesForGender.forEach(p => { if (p.gender) genderTotals[p.gender] = (genderTotals[p.gender] || 0) + 1; });
    const totalWithGender = Object.values(genderTotals).reduce((a, b) => a + b, 0);
    function apportionByTeam(total) {
        if (!total || !totalWithGender) return new Map(teams.map(t => [t.id, 0]));
        const rows = teams.map(t => {
            const exact = targetSize.get(t.id) * (total / totalWithGender);
            return { id: t.id, base: Math.floor(exact), frac: exact - Math.floor(exact) };
        });
        const leftover = total - rows.reduce((s, r) => s + r.base, 0);
        [...rows].sort((a, b) => b.frac - a.frac || a.id - b.id).slice(0, leftover).forEach(r => { r.base += 1; });
        return new Map(rows.map(r => [r.id, r.base]));
    }
    const genderKeys = Object.keys(genderTotals);
    const genderTargetByTeam = new Map();
    if (genderKeys.length === 2) {
        const [g1, g2] = genderKeys;
        const target1 = apportionByTeam(genderTotals[g1]);
        genderTargetByTeam.set(g1, target1);
        genderTargetByTeam.set(g2, new Map(teams.map(t => [t.id, targetSize.get(t.id) - target1.get(t.id)])));
    } else {
        genderKeys.forEach(g => genderTargetByTeam.set(g, apportionByTeam(genderTotals[g])));
    }
    function genderCap(teamId, gender) {
        const map = genderTargetByTeam.get(gender);
        return map ? map.get(teamId) : Infinity;
    }
    function femaleTarget(teamId) {
        const map = genderTargetByTeam.get("여성");
        return map ? map.get(teamId) : null;
    }

    // ---- 팀 하나의 점수 ----
    // "3명"·"4명" 문턱은 이 앱의 실제 미션 규칙(참여 인원 최소 3명)에 맞춘 절대 기준이라 팀 크기와
    // 무관하게 고정한다. "팀 전원이 되는 시간대"만 실제 팀 목표 인원(S)에 맞춰 일반화했다.
    function scoreTeam(members, teamId) {
        const S = members.length;
        if (!S) return 0;
        let score = 0;

        const cnt = {};
        members.forEach(m => m.slots.forEach(s => { cnt[s] = (cnt[s] || 0) + 1; }));
        let s3 = 0, s4 = 0, sFull = 0;
        ALL_SLOT_KEYS.forEach(k => {
            const c = cnt[k] || 0;
            if (c >= 3) s3++;
            if (c >= 4) s4++;
            if (c >= S) sFull++;
        });
        const days3 = APPLICATION_DAYS.filter(day => APPLICATION_SLOTS.some(slot => (cnt[day + slot] || 0) >= 3)).length;
        const sat = members.filter(m => m.sat).length;
        const sun = members.filter(m => m.sun).length;

        score += 3 * s3 + 2 * s4 + 4 * sFull + 6 * days3;
        score += (sat >= 3 ? 6 : 0) + (sun >= 3 ? 6 : 0);
        score += (sat >= 3 || sun >= 3) ? 4 : -10;

        members.forEach(m => {
            let inc = 0, best = 0;
            m.slots.forEach(s => { const c = cnt[s] || 0; if (c >= 3) inc++; if (c > best) best = c; });
            score -= 6 * Math.max(0, 4 - inc);
            score -= 10 * Math.max(0, 4 - best);
        });

        // 성비: 하드 제약(genderCap)이 이미 크게 못 벗어나게 막아주니, 여기서는 정확히 계산된
        // 목표치에서 벗어난 정도만 약하게 더 벌점 줘서 그 안에서 최대한 목표치에 가깝게 만든다.
        const target = femaleTarget(teamId);
        if (target != null) score -= 6 * Math.abs(members.filter(m => m.gender === "여성").length - target);

        const hf = members.filter(m => m.freq >= 3).length;
        score -= 8 * Math.max(0, hf - 2);
        if (hf === 0) score -= 10;

        if (members.filter(m => m.outgoing).length === 0) score -= 8;
        score -= 8 * Math.max(0, members.filter(m => m.quiet).length - 2);
        score -= 8 * Math.max(0, members.filter(m => m.hard).length - 2);

        const depts = members.map(m => m.dept).filter(Boolean);
        score -= 5 * (depts.length - new Set(depts).size);

        separationPairs.forEach(([a, b]) => {
            if (members.some(m => m.userId === a) && members.some(m => m.userId === b)) score -= 100;
        });

        return score;
    }

    function membersOfTeam(teamId, state) {
        const movable = [...(state.unitsByTeam.get(teamId) || [])]
            .flatMap(uid => state.unitById.get(uid).userIds.map(id => profileByUserId.get(id)));
        return [...fixedMembersByTeam.get(teamId), ...movable];
    }
    function teamPairScore(t1, t2, state) {
        return scoreTeam(membersOfTeam(t1, state), t1) + scoreTeam(membersOfTeam(t2, state), t2);
    }

    // ---- 초기 배정: 유닛을 큰 순서로, 자리가 남은 팀 중 무작위로 배정 (First-Fit + 랜덤) ----
    // 성별 인원수는 팀마다 매번 처음부터 세지 않고, 유닛이 오갈 때마다 증감만 반영해서 들고
    // 다닌다(state.genderCount) — 안 그러면 담금질 수만 번 반복 동안 매번 팀 전체를 다시 세야
    // 해서 느려진다(실측 56명 기준 몇 초 걸림 → 이 방식으로 바꾸고 1초 미만).
    function unitGenderCounts(unit) {
        const c = {};
        unit.userIds.forEach(id => { const g = profileByUserId.get(id).gender; if (g) c[g] = (c[g] || 0) + 1; });
        return c;
    }
    function applyGenderDelta(genderCount, teamId, unit, sign) {
        const cur = genderCount.get(teamId);
        Object.entries(unitGenderCounts(unit)).forEach(([g, n]) => { cur[g] = (cur[g] || 0) + sign * n; });
    }
    function unitFitsGender(genderCount, teamId, unit) {
        const cur = genderCount.get(teamId);
        return Object.entries(unitGenderCounts(unit)).every(([g, n]) => (cur[g] || 0) + n <= genderCap(teamId, g));
    }

    // ---- 초기 배정도 성별 하드 제약을 지켜야 한다 — 안 그러면 담금질이 아무리 잘 돌아도
    // 처음부터 어긋난 상태를 못 고칠 수 있다(교환은 "양쪽 다 제약을 지키는 경우"만 허용하므로).
    function randomAssign() {
        const cap = new Map(teams.map(t => [t.id, targetSize.get(t.id) - currentCount.get(t.id)]));
        const genderCount = new Map(teams.map(t => {
            const c = {};
            fixedMembersByTeam.get(t.id).forEach(m => { if (m.gender) c[m.gender] = (c[m.gender] || 0) + 1; });
            return [t.id, c];
        }));
        const unitsByTeam = new Map(teams.map(t => [t.id, new Set()]));
        const unitById = new Map();
        const teamOfUnit = new Map();
        [...units].sort((a, b) => b.userIds.length - a.userIds.length).forEach((u, i) => {
            const unitId = "u" + i;
            unitById.set(unitId, u);
            const sizeFits = teams.filter(t => cap.get(t.id) >= u.userIds.length);
            const sizePool = sizeFits.length ? sizeFits : teams; // 인원수가 정확히 안 맞아 자리가 부족하면 넘침 허용
            const genderFits = sizePool.filter(t => unitFitsGender(genderCount, t.id, u));
            const pool = genderFits.length ? genderFits : sizePool; // 그래도 없으면 성별은 일단 넘어가고 나중에 담금질이 최대한 고친다
            const t = pool[Math.floor(Math.random() * pool.length)];
            unitsByTeam.get(t.id).add(unitId);
            teamOfUnit.set(unitId, t.id);
            cap.set(t.id, cap.get(t.id) - u.userIds.length);
            applyGenderDelta(genderCount, t.id, u, 1);
        });
        return { unitsByTeam, unitById, teamOfUnit, genderCount };
    }
    function cloneState(state) {
        return {
            unitsByTeam: new Map([...state.unitsByTeam].map(([k, v]) => [k, new Set(v)])),
            unitById: state.unitById, // 유닛 내용 자체는 안 바뀌니 공유해도 안전하다
            teamOfUnit: new Map(state.teamOfUnit),
            genderCount: new Map([...state.genderCount].map(([k, v]) => [k, { ...v }])),
        };
    }

    function fitsGenderAfterSwap(teamId, unitsOut, unitsIn, state) {
        const cur = state.genderCount.get(teamId);
        const delta = {};
        unitsOut.forEach(u => Object.entries(unitGenderCounts(u)).forEach(([g, n]) => { delta[g] = (delta[g] || 0) - n; }));
        unitsIn.forEach(u => Object.entries(unitGenderCounts(u)).forEach(([g, n]) => { delta[g] = (delta[g] || 0) + n; }));
        return Object.entries(delta).every(([g, d]) => (cur[g] || 0) + d <= genderCap(teamId, g));
    }
    function pickSample(arr, n) {
        const copy = [...arr], picked = [];
        for (let i = 0; i < n && copy.length; i++) picked.push(copy.splice(Math.floor(Math.random() * copy.length), 1)[0]);
        return picked;
    }
    // 팀 두 개를 골라 유닛 1~2개씩(인원 수 합이 같은 조합)을 서로 바꾼다 — 성별 하드 제약을 어기면 버린다.
    function tryNeighbor(state) {
        for (let attempt = 0; attempt < 20; attempt++) {
            const t1 = teams[Math.floor(Math.random() * teams.length)];
            const t2 = teams[Math.floor(Math.random() * teams.length)];
            if (t1.id === t2.id) continue;
            const list1 = [...state.unitsByTeam.get(t1.id)], list2 = [...state.unitsByTeam.get(t2.id)];
            if (!list1.length || !list2.length) continue;
            const n1 = list1.length >= 2 && Math.random() < 0.3 ? 2 : 1;
            const n2 = list2.length >= 2 && Math.random() < 0.3 ? 2 : 1;
            const aIds = pickSample(list1, n1), bIds = pickSample(list2, n2);
            const aUnits = aIds.map(id => state.unitById.get(id)), bUnits = bIds.map(id => state.unitById.get(id));
            const sizeA = aUnits.reduce((s, u) => s + u.userIds.length, 0);
            const sizeB = bUnits.reduce((s, u) => s + u.userIds.length, 0);
            if (sizeA !== sizeB) continue;
            if (!fitsGenderAfterSwap(t1.id, aUnits, bUnits, state)) continue;
            if (!fitsGenderAfterSwap(t2.id, bUnits, aUnits, state)) continue;
            return { t1: t1.id, t2: t2.id, aIds, bIds, aUnits, bUnits };
        }
        return null;
    }
    function applyMove(state, move) {
        const aUnits = move.aUnits || move.aIds.map(id => state.unitById.get(id));
        const bUnits = move.bUnits || move.bIds.map(id => state.unitById.get(id));
        move.aIds.forEach((id, i) => {
            state.unitsByTeam.get(move.t1).delete(id); state.unitsByTeam.get(move.t2).add(id); state.teamOfUnit.set(id, move.t2);
            applyGenderDelta(state.genderCount, move.t1, aUnits[i], -1);
            applyGenderDelta(state.genderCount, move.t2, aUnits[i], 1);
        });
        move.bIds.forEach((id, i) => {
            state.unitsByTeam.get(move.t2).delete(id); state.unitsByTeam.get(move.t1).add(id); state.teamOfUnit.set(id, move.t1);
            applyGenderDelta(state.genderCount, move.t2, bUnits[i], -1);
            applyGenderDelta(state.genderCount, move.t1, bUnits[i], 1);
        });
    }

    // ---- 담금질(simulated annealing) — 여러 번 재시작해서 그중 제일 좋은 배정을 고른다 ----
    // 원안(16회×6만 반복)은 Python 기준 1~2분짜리다. Node는 요청 하나를 처리하는 동안 다른 모든
    // 요청(실시간 리더보드 등)도 같이 멈추기 때문에, 그 정도로 오래 걸리면 안 된다. 56명(8팀)
    // 기준으로 재보면서 3초 안팎에 끝나는 선까지 줄였다 — 조금 덜 파고들어도 하드 제약(성별·그룹)은
    // 애초에 어길 수가 없고, 소프트 점수도 실전에서 쓰기엔 충분히 좋은 배정이 나온다.
    const RESTARTS = units.length > 1 ? 10 : 1;
    const ITERS = 3000;
    let best = null, bestScore = -Infinity;
    for (let r = 0; r < RESTARTS; r++) {
        const state = randomAssign();
        let curScore = teams.reduce((sum, t) => sum + scoreTeam(membersOfTeam(t.id, state), t.id), 0);
        let temp = 30;
        for (let i = 0; i < ITERS; i++) {
            const move = tryNeighbor(state);
            if (move) {
                const before = teamPairScore(move.t1, move.t2, state);
                applyMove(state, move);
                const after = teamPairScore(move.t1, move.t2, state);
                const newScore = curScore - before + after;
                if (newScore > curScore || Math.random() < Math.exp((newScore - curScore) / temp)) {
                    curScore = newScore;
                } else {
                    // 되돌리기: t1/t2 역할만 바꾸고 aIds/bIds는 그대로 — a는 지금 t2에 있으니 t2→t1로,
                    // b는 지금 t1에 있으니 t1→t2로 돌아간다.
                    applyMove(state, { t1: move.t2, t2: move.t1, aIds: move.aIds, bIds: move.bIds });
                }
            }
            temp = Math.max(0.3, temp * 0.9995);
            if (curScore > bestScore) { best = cloneState(state); bestScore = curScore; }
        }
    }
    if (!best) best = randomAssign();

    // ---- 결과 반영 ----
    best.unitById.forEach((unit, unitId) => {
        const teamId = best.teamOfUnit.get(unitId);
        unit.userIds.forEach(id => { data.users.find(u => u.id === id).teamId = teamId; });
    });

    // ---- 팀별 진단 정보 — 관리자가 결과를 검토할 때 참고하도록 ----
    const diagnostics = teams.map(t => {
        const members = membersOfTeam(t.id, best);
        const female = members.filter(m => m.gender === "여성").length;
        const depts = {};
        members.forEach(m => { if (m.dept) depts[m.dept] = (depts[m.dept] || 0) + 1; });
        const years = members.map(m => studentYear(m.studentId)).filter(y => y != null);
        return {
            teamId: t.id, teamName: t.name, size: members.length,
            female, male: members.length - female,
            weekendSat: members.filter(m => m.sat).length, weekendSun: members.filter(m => m.sun).length,
            activeEngines: members.filter(m => m.freq >= 3).length,
            departments: depts,
            studentYears: years.length ? [Math.min(...years), Math.max(...years)] : null,
            separationViolations: separationPairs.filter(([a, b]) => members.some(m => m.userId === a) && members.some(m => m.userId === b)).length,
        };
    });

    return {
        assignedCount: eligible.length,
        teamSizes: Object.fromEntries(teams.map(t => [t.name, membersOfTeam(t.id, best).length])),
        score: Math.round(bestScore),
        diagnostics,
        warnings: [...unresolved.map(n => `제외자 목록에서 찾을 수 없는 이름: ${n}`), ...configWarnings],
    };
}

app.get("/api/hygo/admin/auto-assign-config", requireAdmin, (req, res) => {
    res.json({ config: data.autoAssignConfig || { excludedNames: [], fixedGroups: [], separationPairs: [] } });
});

app.post("/api/hygo/admin/auto-assign-config", requireAdmin, (req, res) => {
    const body = req.body || {};
    const cleanNames = arr => Array.isArray(arr) ? arr.map(s => String(s || "").trim()).filter(Boolean) : [];
    const cleanGroups = arr => Array.isArray(arr) ? arr.map(cleanNames).filter(g => g.length > 1) : [];
    const cleanPairs = arr => Array.isArray(arr)
        ? arr.map(p => cleanNames(p)).filter(p => p.length === 2)
        : [];
    data.autoAssignConfig = {
        excludedNames: cleanNames(body.excludedNames),
        fixedGroups: cleanGroups(body.fixedGroups),
        separationPairs: cleanPairs(body.separationPairs),
    };
    persist();
    res.json({ ok: true, config: data.autoAssignConfig });
});

app.post("/api/hygo/admin/auto-assign", requireAdmin, (req, res) => {
    if (data.teams.length < 1) return res.status(400).json({ error: "팀이 없습니다. 먼저 팀을 만들어주세요." });
    const result = runAutoAssign();
    if (result.error) return res.status(400).json({ error: result.error });
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
// 관리자 암호 없이도 삭제를 허용한다. 대기(pending) 상태도 마찬가지로 점수에 아직 반영 안 됐으니
// 제출한 본인이 직접 취소할 수 있게 한다. 승인된(approved) 건은 점수에 영향을 주므로 관리자만 지운다.
app.delete("/api/hygo/submissions/:id", async (req, res) => {
    const idx = data.submissions.findIndex(s => s.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: "인증을 찾을 수 없습니다." });
    const sub = data.submissions[idx];
    const isAdminReq = req.get("x-admin-password") === ADMIN_PASSWORD;
    const currentUser = getCurrentUser(req);
    const isOwnPending = sub.status === "pending" && currentUser && sub.authorId === currentUser.id;
    if (sub.status !== "rejected" && !isOwnPending && !isAdminReq) {
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
        res.json(await buildFullExport());
    } catch (e) {
        res.status(500).json({ error: "백업 생성에 실패했습니다." });
    }
});

// 자동 백업 목록(메타데이터만 — 내용은 안 실어서 가볍다)
app.get("/api/hygo/admin/backups", requireAdmin, (req, res) => {
    const list = [...(data.backups || [])].sort((a, b) => b.date.localeCompare(a.date));
    res.json({ backups: list, lastBackupAt: data.lastBackupAt });
});

// 특정 날짜 자동 백업의 실제 내용(사진 포함, 수동 백업 다운로드와 동일한 형식)
app.get("/api/hygo/admin/backups/:date", requireAdmin, async (req, res) => {
    try {
        const snapshot = await loadBackupSnapshot(req.params.date);
        if (!snapshot) return res.status(404).json({ error: "해당 날짜의 백업을 찾을 수 없습니다." });
        // 저장은 가볍게(사진 URL만) 해뒀지만, 다운로드/복원 시점엔 사진을 실제로 채워서 돌려준다 —
        // 다운로드한 파일이 그 자체만으로 완전한 백업이 되도록, 그리고 복원 시 굳이 사진을
        // 다시 찾아 연결할 필요 없이 바로 저장되도록.
        res.json(await resolvePhotos(snapshot));
    } catch (e) {
        res.status(500).json({ error: "백업을 불러오지 못했습니다." });
    }
});

// 지금 바로 백업 한 번 찍기(23시간 대기 무시) — 위험한 작업 전에 수동으로 눌러둘 수 있게.
app.post("/api/hygo/admin/backups/run", requireAdmin, async (req, res) => {
    const result = await runDailyBackupIfDue(true);
    if (result.entry && !result.entry.ok) {
        return res.status(502).json({ error: `백업 저장에 실패했어요: ${result.entry.error}` });
    }
    res.json({ ok: true, entry: result.entry });
});

// 두 초기화 버튼은 예전엔 지워지는 제출물의 사진까지 같이 영구 삭제했다. 한 달 넘게 이어지는
// 행사 중에 실수로라도 이 버튼을 누르면 그동안 쌓인 인증 사진이 통째로 날아간다는 뜻이라,
// 이제는 사진 파일은 지우지 않는다(제출물 데이터만 초기화). 개별 인증을 하나씩 지우는 것과
// 달리 "전체 초기화"는 되돌릴 방법이 없는 대량 삭제라서, 사진만큼은 보험 삼아 남겨둔다.
// 안 쓰는 사진이 계속 쌓이긴 하지만, 압축된 인증샷 용량을 감안하면 한 학기 분량도 Upstash
// 무료 저장 용량에 여유 있게 들어간다.
app.post("/api/hygo/reset", requireAdmin, async (req, res) => {
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
});

app.post("/api/hygo/reset-zero", requireAdmin, async (req, res) => {
    data.teams = data.teams.map(t => ({ ...t, points: 0, missionsCount: 0 }));
    data.submissions = [];
    data.adjustments = [];
    persist();
    broadcast();
    res.json({ ok: true });
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
        // 샘플 데이터의 자리채움 사진(placeholderPhoto)은 "data:image/svg+xml;utf8,..." 형태라
        // "data:image/"로 시작하긴 하지만 base64가 아니다. 이걸 실제 업로드된 사진처럼 별도
        // 파일로 저장해버리면(그리고 나중에 /api/hygo/photo/:id로 불러올 때 base64 디코딩이
        // 실패해서 500 에러가 난다), 그냥 원래 형태(인라인) 그대로 둬야 한다.
        if (typeof clone.photo === "string" && /^data:[^;]+;base64,/.test(clone.photo)) {
            try {
                await savePhoto(clone.id, clone.photo);
                clone.photo = `/api/hygo/photo/${clone.id}`;
            } catch (e) {
                return res.status(502).json({ error: "백업 사진 복원에 실패했습니다." });
            }
        }
        importedSubmissions.push(clone);
    }

    // 백업 목록/구독 정보 등은 "복원 대상 데이터"가 아니라 이 서버 자체의 운영 상태라서,
    // 백업 파일에 들어있는 값이 아니라 지금(복원 직전) 값을 그대로 들고 간다 — 안 그러면
    // 복원할 때마다 자동 백업 이력이나 푸시 구독이 전부 비워져 버린다.
    const { backups, lastBackupAt, pushSubscriptions, vapidKeys, autoAssignConfig } = data;
    data = normalizeCampaign({
        teams: incoming.teams.map(t => ({ ...t, points: Number(t.points) || 0, missionsCount: Number(t.missionsCount) || 0 })),
        submissions: importedSubmissions,
        adjustments: incoming.adjustments,
        campaign: incoming.campaign,
        users: incoming.users,
        missions: incoming.missions,
        applications: incoming.applications,
        activityOptions: incoming.activityOptions,
        backups, lastBackupAt, pushSubscriptions, vapidKeys, autoAssignConfig,
    });
    persist();
    broadcast();
    res.json({ ok: true });

    // 복원은 백업 안에 들어있던 원래 id를 그대로 재사용하기 때문에(새로 안 만듦), 같은 백업을
    // 두 번 복원하거나 겹치는 id가 있는 상태에서 복원하면 "이전 제출물들의 사진 정리"가 방금
    // 새로 저장한(=이번에도 여전히 쓰이는) 사진 파일을 같이 지워버릴 수 있었다. 새로 들어온
    // 쪽에서 여전히 쓰는 id는 정리 대상에서 빼야 한다.
    const stillUsedIds = new Set(importedSubmissions.map(s => s.id));
    for (const sub of oldSubmissions) {
        if (isStoredPhotoRef(sub.photo) && !stillUsedIds.has(sub.id)) await deletePhoto(photoRefId(sub.photo));
    }
});

// 예상 못한 비동기 에러 하나 때문에 서버 전체가 죽는 것을 막는 최후의 안전망.
// (예: fire-and-forget로 호출한 어딘가에서 처리 안 된 예외가 나는 경우)
process.on("unhandledRejection", err => {
    console.error("[hygo] unhandled promise rejection (server kept running):", err);
});

async function main() {
    data = await loadData();

    if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) {
        if (!data.vapidKeys) {
            data.vapidKeys = webpush.generateVAPIDKeys();
            persist();
        }
        VAPID_PUBLIC_KEY = data.vapidKeys.publicKey;
        VAPID_PRIVATE_KEY = data.vapidKeys.privateKey;
    }
    webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

    // 서버가 깨어있는 동안 30분마다 "오늘 백업 아직 안 했으면 지금 한다"를 체크한다(위의
    // runDailyBackupIfDue 주석 참고 — 무료 플랜 슬립 때문에 정확한 시각 타이머는 못 믿는다).
    runDailyBackupIfDue().catch(e => console.warn("[hygo] backup check failed:", e.message));
    setInterval(() => {
        runDailyBackupIfDue().catch(e => console.warn("[hygo] backup check failed:", e.message));
    }, 30 * 60 * 1000);

    const PORT = process.env.HYGO_PORT || 4000;
    server.listen(PORT, "0.0.0.0", () => {
        console.log(`HY-GO server running on port ${PORT}`);
        console.log(REDIS_ENABLED
            ? "[hygo] persistent storage: Upstash Redis (data survives restarts)"
            : "[hygo] persistent storage: local file — WARNING: data will NOT survive Render restarts/sleep on the free tier");
    });
}

main();
