// 故障带分析：纯计算 + 状态对账，不依赖 HTTP 与具体存储实现。
//
// 判定规则（同一孔位跨段反复出错）：
// 1. 区间相邻：同一曲目、按拍号排序后区间相接或重叠（中间至多空 1 拍，允许重打重叠）；
// 2. 同一位置：相邻两区间各有一条“未解决”问题，音轨相同且拍号相差不超过 1 拍
//    （跨接缝的同一个孔），满足即在两区间间连边；
// 3. 连通分量包含至少 2 个区间即归为一条故障带；
// 4. 带内区间转待复核（pending_review），进度单列；
// 5. 重试通过把问题置为 resolved 后重新分析，连边全部消失则撤下故障带
//    （status=withdrawn 留痕），原始问题记录始终保留。

const BEAT_TOLERANCE = 1; // 同一位置允许的拍号差
const MAX_GAP_BEATS = 1; // 相邻区间之间至多空 1 拍

function parseLaneRange(laneRange) {
  if (typeof laneRange !== "string") return null;
  const match = laneRange.match(/^\s*(\d+)\s*-\s*(\d+)\s*$/);
  if (!match) return null;
  const low = Number(match[1]);
  const high = Number(match[2]);
  if (Number.isNaN(low) || Number.isNaN(high) || low > high) return null;
  return [low, high];
}

function lanesOverlap(rangeA, rangeB) {
  const a = parseLaneRange(rangeA);
  const b = parseLaneRange(rangeB);
  if (!a || !b) return false;
  return a[0] <= b[1] && b[0] <= a[1];
}

// 区间按拍号是否相接/重叠
function sectionsAdjacent(a, b) {
  if (a.tuneId !== b.tuneId) return false;
  const [first, second] = a.startBeat <= b.startBeat ? [a, b] : [b, a];
  if (!lanesOverlap(first.laneRange, second.laneRange)) return false;
  const gap = second.startBeat - first.endBeat - 1;
  return gap <= MAX_GAP_BEATS;
}

// 两条问题是否打在同一个孔位上
function issuesSamePosition(a, b) {
  if (a.lane === null || a.lane === undefined || b.lane === null || b.lane === undefined) return false;
  if (a.beat === null || a.beat === undefined || b.beat === null || b.beat === undefined) return false;
  return Number(a.lane) === Number(b.lane) && Math.abs(Number(a.beat) - Number(b.beat)) <= BEAT_TOLERANCE;
}

function isOpen(issue) {
  return issue.status !== "resolved";
}

class UnionFind {
  constructor(items) {
    this.parent = new Map(items.map((item) => [item, item]));
  }
  find(item) {
    const root = this.parent.get(item);
    if (root === undefined) return undefined;
    if (root === item) return item;
    const top = this.find(root);
    this.parent.set(item, top);
    return top;
  }
  union(a, b) {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra === undefined || rb === undefined || ra === rb) return;
    this.parent.set(ra, rb);
  }
  groups() {
    const map = new Map();
    for (const item of this.parent.keys()) {
      const root = this.find(item);
      if (!map.has(root)) map.set(root, []);
      map.get(root).push(item);
    }
    return [...map.values()];
  }
}

// 依据当前问题状态，算出某曲目全部“在役”故障带（不写数据）
function computeBands(db, tuneId) {
  const sections = db.sections
    .filter((section) => section.tuneId === tuneId)
    .sort((a, b) => a.startBeat - b.startBeat || a.endBeat - b.endBeat || a.id.localeCompare(b.id));
  const sectionById = new Map(sections.map((section) => [section.id, section]));
  const openIssues = db.issues.filter((issue) => issue.tuneId === tuneId && isOpen(issue));

  const uf = new UnionFind(sections.map((section) => section.id));
  // key: sectionA|sectionB -> 促成这条边的未解决问题与音轨
  const edges = new Map();

  for (let i = 0; i < sections.length; i += 1) {
    for (let j = i + 1; j < sections.length; j += 1) {
      const a = sections[i];
      const b = sections[j];
      if (!sectionsAdjacent(a, b)) continue;
      const issuesA = openIssues.filter((issue) => issue.sectionId === a.id);
      const issuesB = openIssues.filter((issue) => issue.sectionId === b.id);
      const hits = [];
      for (const ia of issuesA) {
        for (const ib of issuesB) {
          if (issuesSamePosition(ia, ib)) hits.push([ia, ib]);
        }
      }
      if (!hits.length) continue;
      uf.union(a.id, b.id);
      const edgeKey = [a.id, b.id].sort().join("|");
      edges.set(edgeKey, {
        sectionIds: [a.id, b.id],
        issueIds: [...new Set(hits.flat().map((issue) => issue.id))],
        lanes: [...new Set(hits.flat().map((issue) => Number(issue.lane)))]
      });
    }
  }

  const bands = [];
  for (const group of uf.groups()) {
    if (group.length < 2) continue;
    const orderedIds = group.sort(
      (x, y) =>
        sectionById.get(x).startBeat - sectionById.get(y).startBeat ||
        sectionById.get(x).endBeat - sectionById.get(y).endBeat ||
        x.localeCompare(y)
    );
    const memberEdges = [...edges.values()].filter(
      (edge) => orderedIds.includes(edge.sectionIds[0]) && orderedIds.includes(edge.sectionIds[1])
    );
    const linkedIssueIds = [...new Set(memberEdges.flatMap((edge) => edge.issueIds))];
    const lanes = [...new Set(memberEdges.flatMap((edge) => edge.lanes))].sort((a, b) => a - b);
    const openIssueIds = openIssues
      .filter((issue) => orderedIds.includes(issue.sectionId))
      .map((issue) => issue.id);
    bands.push({
      key: canonicalKey(tuneId, orderedIds),
      tuneId,
      sectionIds: orderedIds,
      lanes,
      startBeat: sectionById.get(orderedIds[0]).startBeat,
      endBeat: Math.max(...orderedIds.map((id) => sectionById.get(id).endBeat)),
      linkedIssueIds,
      openIssueIds
    });
  }
  return bands.sort((a, b) => a.startBeat - b.startBeat || a.key.localeCompare(b.key));
}

function enrichBand(db, band) {
  return {
    ...(band.id ? { id: band.id } : {}),
    tuneId: band.tuneId,
    sectionIds: band.sectionIds,
    lanes: band.lanes,
    startBeat: band.startBeat,
    endBeat: band.endBeat,
    linkedIssueIds: band.linkedIssueIds,
    openIssueIds: band.openIssueIds,
    sections: band.sectionIds.map((id) => db.sections.find((section) => section.id === id) || null),
    openCount: band.openIssueIds.length,
    linkedOpenCount: band.linkedIssueIds.length
  };
}

// 同一组成员的故障带身份不变（成员按 id 排序后规范成键）
function canonicalKey(tuneId, sectionIds) {
  return [tuneId, ...[...sectionIds].sort()].join(":");
}

// 把分析结果对账到数据：新建/恢复/撤下故障带，刷新区间复核状态
function reconcileTune(db, tuneId, options = {}) {
  const now = options.now || new Date().toISOString();
  const idMaker = options.idMaker || ((prefix) => `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`);

  const computed = computeBands(db, tuneId);
  const existing = db.faultBands.filter((band) => band.tuneId === tuneId);
  let changed = false;

  for (const computedBand of computed) {
    const old = existing.find((band) => canonicalKey(band.tuneId, band.sectionIds) === computedBand.key);
    if (!old) {
      db.faultBands.push({
        id: idMaker("faultband"),
        tuneId: computedBand.tuneId,
        sectionIds: computedBand.sectionIds,
        lanes: computedBand.lanes,
        startBeat: computedBand.startBeat,
        endBeat: computedBand.endBeat,
        linkedIssueIds: computedBand.linkedIssueIds,
        openIssueIds: computedBand.openIssueIds,
        status: "active",
        createdAt: now,
        updatedAt: now,
        withdrawnAt: null
      });
      changed = true;
    } else {
      const revived = old.status !== "active";
      if (
        revived ||
        JSON.stringify(old.sectionIds) !== JSON.stringify(computedBand.sectionIds) ||
        JSON.stringify(old.lanes) !== JSON.stringify(computedBand.lanes) ||
        old.startBeat !== computedBand.startBeat ||
        old.endBeat !== computedBand.endBeat ||
        JSON.stringify(old.linkedIssueIds) !== JSON.stringify(computedBand.linkedIssueIds) ||
        JSON.stringify(old.openIssueIds) !== JSON.stringify(computedBand.openIssueIds)
      ) {
        Object.assign(old, {
          sectionIds: computedBand.sectionIds,
          lanes: computedBand.lanes,
          startBeat: computedBand.startBeat,
          endBeat: computedBand.endBeat,
          linkedIssueIds: computedBand.linkedIssueIds,
          openIssueIds: computedBand.openIssueIds,
          status: "active",
          updatedAt: now,
          withdrawnAt: revived ? null : old.withdrawnAt
        });
        changed = true;
      }
    }
  }

  const activeKeys = new Set(computed.map((band) => band.key));
  for (const band of existing) {
    if (band.status === "active" && !activeKeys.has(canonicalKey(band.tuneId, band.sectionIds))) {
      band.status = "withdrawn";
      band.withdrawnAt = now;
      band.updatedAt = now;
      changed = true;
    }
  }

  const activeBands = db.faultBands.filter((band) => band.tuneId === tuneId && band.status === "active");
  const sectionState = new Map();
  for (const band of activeBands) {
    for (const sectionId of band.sectionIds) sectionState.set(sectionId, band.id);
  }
  for (const section of db.sections.filter((item) => item.tuneId === tuneId)) {
    const bandId = sectionState.get(section.id) || null;
    const nextState = bandId ? "pending_review" : "normal";
    if (section.reviewState !== nextState || section.faultBandId !== bandId) {
      section.reviewState = nextState;
      section.faultBandId = bandId;
      changed = true;
    }
  }

  return { changed, bands: activeBands.map((band) => enrichBand(db, band)) };
}

// 全量对账（服务启动迁移及批量场景使用）
function reconcileAll(db, options = {}) {
  const tuneIds = [...new Set(db.tunes.map((tune) => tune.id))];
  let changed = false;
  const bands = [];
  for (const tuneId of tuneIds) {
    const result = reconcileTune(db, tuneId, options);
    changed = changed || result.changed;
    bands.push(...result.bands);
  }
  return { changed, bands };
}

// 待复核进度（单列展示）
function buildReviewProgress(db, tuneId) {
  const sections = db.sections
    .filter((section) => section.tuneId === tuneId && section.reviewState === "pending_review")
    .sort((a, b) => a.startBeat - b.startBeat);
  const activeBands = db.faultBands.filter((band) => band.tuneId === tuneId && band.status === "active");
  const pendingSectionIds = new Set(sections.map((section) => section.id));
  const openIssues = db.issues.filter(
    (issue) => issue.tuneId === tuneId && pendingSectionIds.has(issue.sectionId) && isOpen(issue)
  );
  return {
    tuneId,
    faultBandCount: activeBands.length,
    pendingReviewSections: sections.length,
    openIssuesInBands: openIssues.length,
    faultBandIds: activeBands.map((band) => band.id)
  };
}

module.exports = {
  BEAT_TOLERANCE,
  MAX_GAP_BEATS,
  parseLaneRange,
  lanesOverlap,
  sectionsAdjacent,
  issuesSamePosition,
  computeBands,
  reconcileTune,
  reconcileAll,
  buildReviewProgress,
  canonicalKey,
  enrichBand
};
