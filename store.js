const { readFile, writeFile, mkdir } = require("fs/promises");
const path = require("path");

const DB_FILE = process.env.DB_FILE || path.join(__dirname, "data", "db.json");

function initialData() {
  const now = new Date().toISOString();
  return {
    tunes: [
      {
        id: "tune_demo",
        title: "雨后圆舞曲",
        composer: "匿名",
        stripSpec: {
          widthMm: 70,
          scale: "20音",
          tempoBpm: 82,
          paperType: "半透明纸带"
        },
        createdAt: now
      }
    ],
    sections: [
      {
        id: "section_demo_1",
        tuneId: "tune_demo",
        startBeat: 1,
        endBeat: 32,
        laneRange: "1-10",
        checked: true,
        note: "开头主题已试奏",
        reviewState: "normal",
        faultBandId: null
      },
      {
        id: "section_demo_2",
        tuneId: "tune_demo",
        startBeat: 33,
        endBeat: 64,
        laneRange: "4-18",
        checked: false,
        note: "副歌段等待校对",
        reviewState: "normal",
        faultBandId: null
      }
    ],
    issues: [
      {
        id: "issue_demo",
        tuneId: "tune_demo",
        sectionId: "section_demo_2",
        type: "漏孔",
        beat: 41,
        lane: 12,
        description: "第41拍高音孔漏打",
        status: "open",
        createdAt: now,
        resolvedAt: null
      }
    ],
    faultBands: []
  };
}

async function ensureDb() {
  await mkdir(path.dirname(DB_FILE), { recursive: true });
  try {
    JSON.parse(await readFile(DB_FILE, "utf8"));
  } catch {
    await writeFile(DB_FILE, JSON.stringify(initialData(), null, 2));
  }
}

async function readDb() {
  await ensureDb();
  const db = JSON.parse(await readFile(DB_FILE, "utf8"));
  const { data, changed } = migrate(db);
  // 结构迁移一次性补进现有数据（不改变任何业务记录）
  if (changed) await writeDb(data);
  return data;
}

async function writeDb(data) {
  await writeFile(DB_FILE, JSON.stringify(data, null, 2));
}

// 结构迁移：给老数据补上故障带集合与区间复核状态，不改动任何业务记录
function migrate(db) {
  let changed = false;
  for (const key of ["tunes", "sections", "issues", "faultBands"]) {
    if (!Array.isArray(db[key])) {
      db[key] = [];
      changed = true;
    }
  }
  for (const section of db.sections) {
    if (section.reviewState === undefined) {
      section.reviewState = "normal";
      changed = true;
    }
    if (section.faultBandId === undefined) {
      section.faultBandId = null;
      changed = true;
    }
  }
  return { data: db, changed };
}

function makeId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

module.exports = { DB_FILE, initialData, ensureDb, readDb, writeDb, migrate, makeId };
