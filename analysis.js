// 计算层：故障带分析与进度统计。纯函数，不直接读写存储。

function isOpen(issue) {
  return issue.status !== "resolved";
}

function parseLaneRange(laneRange) {
  const match = String(laneRange || "").match(/(\d+)\s*-\s*(\d+)/);
  if (!match) return null;
  return [Number(match[1]), Number(match[2])];
}

// 音轨必须落在区间的音轨范围内，才算这个位置在该区间可复现
function laneCovered(section, lane) {
  const range = parseLaneRange(section.laneRange);
  return Boolean(range) && lane >= range[0] && lane <= range[1];
}

// 按拍号判断两个区间是否相邻（首尾相接或重叠）
function sectionsAdjacent(prev, next) {
  return next.startBeat <= prev.endBeat + 1;
}

function buildBand(tuneId, lane, run, issues) {
  const sectionIds = run.map((section) => section.id);
  const related = issues.filter((issue) => issue.lane === lane && sectionIds.includes(issue.sectionId));
  const open = related.filter(isOpen);
  return {
    id: `band_${tuneId}_lane${lane}_${run[0].id}`,
    tuneId,
    lane,
    sectionIds,
    beatRange: { startBeat: run[0].startBeat, endBeat: run[run.length - 1].endBeat },
    issueIds: related.map((issue) => issue.id),
    openIssueIds: open.map((issue) => issue.id),
    status: "active"
  };
}

// 同一音轨在连续两段以上相邻区间都出现未解决问题 -> 归成一条故障带
function analyzeFaultBands(tuneId, sections, issues) {
  const sorted = [...sections].sort((a, b) => a.startBeat - b.startBeat || String(a.id).localeCompare(String(b.id)));
  const openIssues = issues.filter((issue) => isOpen(issue) && issue.lane !== null && issue.lane !== undefined);
  const lanes = [...new Set(openIssues.map((issue) => issue.lane))].sort((a, b) => a - b);
  const bands = [];
  for (const lane of lanes) {
    let run = [];
    const flush = () => {
      if (run.length >= 2) bands.push(buildBand(tuneId, lane, run, issues));
      run = [];
    };
    for (const section of sorted) {
      const hit = laneCovered(section, lane) && openIssues.some((issue) => issue.sectionId === section.id && issue.lane === lane);
      if (hit && (run.length === 0 || sectionsAdjacent(run[run.length - 1], section))) {
        run.push(section);
      } else {
        flush();
        if (hit) run.push(section);
      }
    }
    flush();
  }
  return bands.sort((a, b) => a.beatRange.startBeat - b.beatRange.startBeat || a.lane - b.lane);
}

// 把某曲目的分析结果写回数据：刷新故障带列表与区间复核状态。
// 带内未解决问题清零时故障带自然撤下，区间恢复 normal；问题记录本身不动。
function applyTuneAnalysis(db, tuneId, now = new Date().toISOString()) {
  const sections = db.sections.filter((section) => section.tuneId === tuneId);
  const issues = db.issues.filter((issue) => issue.tuneId === tuneId);
  const previous = new Map((db.faultBands || []).filter((band) => band.tuneId === tuneId).map((band) => [band.id, band]));
  const bands = analyzeFaultBands(tuneId, sections, issues).map((band) => {
    const old = previous.get(band.id);
    return { ...band, createdAt: old ? old.createdAt : now, updatedAt: now };
  });
  db.faultBands = [...(db.faultBands || []).filter((band) => band.tuneId !== tuneId), ...bands];
  const bandSectionIds = new Set(bands.flatMap((band) => band.sectionIds));
  for (const section of db.sections) {
    if (section.tuneId === tuneId) {
      section.reviewStatus = bandSectionIds.has(section.id) ? "pending_review" : "normal";
    }
  }
  return bands;
}

// 老数据补齐：缺 faultBands 字段时全量分析一次并写入复核状态
function migrateAnalysis(db) {
  if (Array.isArray(db.faultBands)) return false;
  db.faultBands = [];
  for (const tune of db.tunes) applyTuneAnalysis(db, tune.id);
  return true;
}

// 进度统计：故障带相关区间单列“待复核”，不计入已完成；无故障带的曲目与原来一致
function buildProgress(db, tuneId) {
  const sections = db.sections.filter((section) => section.tuneId === tuneId);
  const issues = db.issues.filter((issue) => issue.tuneId === tuneId);
  const bands = (db.faultBands || []).filter((band) => band.tuneId === tuneId);
  const pendingReview = sections.filter((section) => section.reviewStatus === "pending_review");
  const checked = sections.filter((section) => section.checked && section.reviewStatus !== "pending_review");
  const openIssues = issues.filter(isOpen).length;
  return {
    tuneId,
    totalSections: sections.length,
    checkedSections: checked.length,
    uncheckedSections: sections.length - checked.length - pendingReview.length,
    pendingReviewSections: pendingReview.length,
    activeFaultBands: bands.length,
    openIssues,
    resolvedIssues: issues.length - openIssues,
    percent: sections.length ? Math.round((checked.length / sections.length) * 100) : 0
  };
}

module.exports = {
  parseLaneRange,
  laneCovered,
  sectionsAdjacent,
  analyzeFaultBands,
  applyTuneAnalysis,
  migrateAnalysis,
  buildProgress
};
