const http = require("http");
const { readDb, writeDb, makeId } = require("./store");
const { reconcileTune, reconcileAll, buildReviewProgress, enrichBand } = require("./faultBands");

const PORT = Number(process.env.PORT || 3019);

const routes = [
  "GET /health",
  "GET /tunes",
  "POST /tunes",
  "GET /tunes/:id/progress",
  "GET /tunes/:id/sections",
  "POST /tunes/:id/sections",
  "GET /tunes/:id/unchecked-sections",
  "PATCH /sections/:id/check",
  "GET /issues",
  "POST /issues",
  "PATCH /issues/:id/status",
  "GET /tunes/:id/fault-bands",
  "POST /tunes/:id/fault-bands/analyze"
];

function send(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body, null, 2));
}

function parseUrl(req) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  return { pathname: url.pathname, searchParams: url.searchParams };
}

async function parseBody(req) {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    const error = new Error("请求体必须是合法JSON");
    error.status = 400;
    throw error;
  }
}

function required(body, fields) {
  const missing = fields.filter((field) => body[field] === undefined || body[field] === "");
  if (missing.length) {
    const error = new Error(`缺少字段：${missing.join(", ")}`);
    error.status = 400;
    throw error;
  }
}

function findTune(db, tuneId) {
  const tune = db.tunes.find((item) => item.id === tuneId);
  if (!tune) {
    const error = new Error("曲目不存在");
    error.status = 404;
    throw error;
  }
  return tune;
}

// 登记/关闭问题或区间变化后重算该曲目的故障带，并把分析与复核状态落库
async function recomputeAndSave(db, tuneId) {
  reconcileTune(db, tuneId, { idMaker: makeId });
  await writeDb(db);
}

function buildProgress(db, tuneId) {
  findTune(db, tuneId);
  const sections = db.sections.filter((item) => item.tuneId === tuneId);
  const issues = db.issues.filter((item) => item.tuneId === tuneId);
  const checkedCount = sections.filter((item) => item.checked).length;
  const openIssues = issues.filter((item) => item.status !== "resolved").length;
  return {
    tuneId,
    totalSections: sections.length,
    checkedSections: checkedCount,
    uncheckedSections: sections.length - checkedCount,
    normalSections: sections.filter((item) => item.reviewState !== "pending_review").length,
    pendingReviewSections: sections.filter((item) => item.reviewState === "pending_review").length,
    openIssues,
    resolvedIssues: issues.length - openIssues,
    percent: sections.length ? Math.round((checkedCount / sections.length) * 100) : 0,
    // 故障带复核进度单列
    review: buildReviewProgress(db, tuneId)
  };
}

function listFaultBands(db, tuneId, includeWithdrawn) {
  const bands = db.faultBands.filter(
    (band) => band.tuneId === tuneId && (includeWithdrawn || band.status === "active")
  );
  return bands
    .slice()
    .sort((a, b) => a.startBeat - b.startBeat || a.id.localeCompare(b.id))
    .map((band) => ({ ...enrichBand(db, band), status: band.status, createdAt: band.createdAt, updatedAt: band.updatedAt, withdrawnAt: band.withdrawnAt }));
}

async function handle(req, res) {
  const { pathname, searchParams } = parseUrl(req);
  const db = await readDb();

  if (req.method === "GET" && pathname === "/health") {
    return send(res, 200, { ok: true, service: "organ-strip-punch-api", routes });
  }

  if (req.method === "GET" && pathname === "/tunes") {
    const tunes = db.tunes.map((tune) => ({ ...tune, progress: buildProgress(db, tune.id) }));
    return send(res, 200, { data: tunes });
  }

  if (req.method === "POST" && pathname === "/tunes") {
    const body = await parseBody(req);
    required(body, ["title", "stripSpec"]);
    const tune = {
      id: makeId("tune"),
      title: body.title,
      composer: body.composer || "",
      stripSpec: body.stripSpec,
      createdAt: new Date().toISOString()
    };
    db.tunes.push(tune);
    await writeDb(db);
    return send(res, 201, { data: tune });
  }

  const tuneSectionsMatch = pathname.match(/^\/tunes\/([^/]+)\/sections$/);
  if (tuneSectionsMatch && req.method === "GET") {
    const tuneId = tuneSectionsMatch[1];
    findTune(db, tuneId);
    return send(res, 200, { data: db.sections.filter((item) => item.tuneId === tuneId) });
  }

  if (tuneSectionsMatch && req.method === "POST") {
    const tuneId = tuneSectionsMatch[1];
    findTune(db, tuneId);
    const body = await parseBody(req);
    required(body, ["startBeat", "endBeat", "laneRange"]);
    const section = {
      id: makeId("section"),
      tuneId,
      startBeat: Number(body.startBeat),
      endBeat: Number(body.endBeat),
      laneRange: body.laneRange,
      checked: Boolean(body.checked),
      note: body.note || "",
      reviewState: "normal",
      faultBandId: null
    };
    db.sections.push(section);
    await recomputeAndSave(db, tuneId);
    return send(res, 201, { data: section });
  }

  const uncheckedMatch = pathname.match(/^\/tunes\/([^/]+)\/unchecked-sections$/);
  if (uncheckedMatch && req.method === "GET") {
    const tuneId = uncheckedMatch[1];
    findTune(db, tuneId);
    return send(res, 200, { data: db.sections.filter((item) => item.tuneId === tuneId && !item.checked) });
  }

  const progressMatch = pathname.match(/^\/tunes\/([^/]+)\/progress$/);
  if (progressMatch && req.method === "GET") {
    return send(res, 200, { data: buildProgress(db, progressMatch[1]) });
  }

  const faultBandsMatch = pathname.match(/^\/tunes\/([^/]+)\/fault-bands$/);
  if (faultBandsMatch && req.method === "GET") {
    const tuneId = faultBandsMatch[1];
    findTune(db, tuneId);
    const includeWithdrawn = searchParams.get("include") === "withdrawn";
    return send(res, 200, { data: listFaultBands(db, tuneId, includeWithdrawn) });
  }

  const analyzeMatch = pathname.match(/^\/tunes\/([^/]+)\/fault-bands\/analyze$/);
  if (analyzeMatch && req.method === "POST") {
    const tuneId = analyzeMatch[1];
    findTune(db, tuneId);
    await recomputeAndSave(db, tuneId);
    return send(res, 200, { data: listFaultBands(db, tuneId, searchParams.get("include") === "withdrawn") });
  }

  const checkMatch = pathname.match(/^\/sections\/([^/]+)\/check$/);
  if (checkMatch && req.method === "PATCH") {
    const section = db.sections.find((item) => item.id === checkMatch[1]);
    if (!section) return send(res, 404, { error: "区间不存在" });
    const body = await parseBody(req);
    section.checked = body.checked !== undefined ? Boolean(body.checked) : true;
    section.note = body.note ?? section.note;
    await writeDb(db);
    return send(res, 200, { data: section });
  }

  if (req.method === "GET" && pathname === "/issues") {
    const tuneId = searchParams.get("tuneId");
    const status = searchParams.get("status");
    const issues = db.issues.filter((item) => (!tuneId || item.tuneId === tuneId) && (!status || item.status === status));
    return send(res, 200, { data: issues });
  }

  if (req.method === "POST" && pathname === "/issues") {
    const body = await parseBody(req);
    required(body, ["tuneId", "sectionId", "type", "description"]);
    findTune(db, body.tuneId);
    const section = db.sections.find((item) => item.id === body.sectionId && item.tuneId === body.tuneId);
    if (!section) return send(res, 400, { error: "区间不存在或不属于该曲目" });
    const issue = {
      id: makeId("issue"),
      tuneId: body.tuneId,
      sectionId: body.sectionId,
      type: body.type,
      beat: body.beat === undefined ? null : Number(body.beat),
      lane: body.lane === undefined ? null : Number(body.lane),
      description: body.description,
      status: "open",
      createdAt: new Date().toISOString(),
      resolvedAt: null
    };
    db.issues.push(issue);
    // 登记问题后立即按拍号和音轨分析相邻区间，必要时归成故障带
    await recomputeAndSave(db, body.tuneId);
    const result = {
      issue,
      review: buildReviewProgress(db, body.tuneId),
      faultBands: listFaultBands(db, body.tuneId, false)
    };
    return send(res, 201, { data: result });
  }

  const issueStatusMatch = pathname.match(/^\/issues\/([^/]+)\/status$/);
  if (issueStatusMatch && req.method === "PATCH") {
    const issue = db.issues.find((item) => item.id === issueStatusMatch[1]);
    if (!issue) return send(res, 404, { error: "问题不存在" });
    const body = await parseBody(req);
    required(body, ["status"]);
    issue.status = body.status;
    issue.resolvedAt = body.status === "resolved" ? new Date().toISOString() : null;
    issue.note = body.note ?? issue.note;
    // 重试通过后重算：连边消失则撤下故障带，原问题记录保留
    await recomputeAndSave(db, issue.tuneId);
    const result = {
      issue,
      review: buildReviewProgress(db, issue.tuneId),
      faultBands: listFaultBands(db, issue.tuneId, false)
    };
    return send(res, 200, { data: result });
  }

  return send(res, 404, { error: "接口不存在", routes });
}

// 启动时把故障带分析与复核状态补齐到已有数据（没有问题的老曲目维持普通处理）
async function syncExistingData() {
  const db = await readDb();
  const result = reconcileAll(db, { idMaker: makeId });
  if (result.changed) await writeDb(db);
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((error) => send(res, error.status || 500, { error: error.message || "服务器错误" }));
});

if (require.main === module) {
  syncExistingData()
    .then(() => {
      server.listen(PORT, () => {
        console.log(`Organ strip punch API running at http://127.0.0.1:${PORT}`);
      });
    })
    .catch((error) => {
      console.error("启动时分析已有数据失败：", error);
      process.exit(1);
    });
}

module.exports = { handle, server, syncExistingData };
