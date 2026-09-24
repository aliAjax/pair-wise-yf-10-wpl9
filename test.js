// 端到端测试：node test.js
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

process.env.DB_FILE = path.join(os.tmpdir(), `fault-bands-test-${process.pid}.json`);

const { createServer } = require("./server");

let base;

async function api(method, url, body) {
  const res = await fetch(`${base}${url}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  return { status: res.status, body: await res.json() };
}

async function main() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}`;

  // 曲目一：完整故障带生命周期。区间 C 与 D 之间留拍号缺口（97、98、99 缺失）
  const tune = (await api("POST", "/tunes", { title: "故障带测试曲", stripSpec: { scale: "20音" } })).body.data;
  const ids = {};
  for (const [key, startBeat, endBeat, checked] of [
    ["A", 1, 32, true],
    ["B", 33, 64, false],
    ["C", 65, 96, false],
    ["D", 100, 130, false]
  ]) {
    const res = await api("POST", `/tunes/${tune.id}/sections`, { startBeat, endBeat, laneRange: "1-10", checked });
    assert.strictEqual(res.status, 201);
    ids[key] = res.body.data.id;
    assert.strictEqual(res.body.data.reviewStatus, "normal");
  }

  const addIssue = async (sectionKey, lane) => {
    const res = await api("POST", "/issues", {
      tuneId: tune.id,
      sectionId: ids[sectionKey],
      type: "错孔",
      beat: 1,
      lane,
      description: `区间${sectionKey}第${lane}轨问题`
    });
    assert.strictEqual(res.status, 201);
    return res.body;
  };

  // 只一段有问题：不成带
  const i1 = (await addIssue("A", 5)).data;
  assert.strictEqual((await api("GET", `/tunes/${tune.id}/fault-bands`)).body.data.length, 0);

  // 同一音轨连续两段：成带，相关区间转待复核
  const i2 = (await addIssue("B", 5)).data;
  let bands = (await api("GET", `/tunes/${tune.id}/fault-bands`)).body.data;
  assert.strictEqual(bands.length, 1);
  assert.deepStrictEqual(bands[0].sectionIds, [ids.A, ids.B]);
  assert.strictEqual(bands[0].lane, 5);
  assert.deepStrictEqual(bands[0].beatRange, { startBeat: 1, endBeat: 64 });
  let sections = (await api("GET", `/tunes/${tune.id}/sections`)).body.data;
  assert.strictEqual(sections.find((s) => s.id === ids.A).reviewStatus, "pending_review");
  assert.strictEqual(sections.find((s) => s.id === ids.B).reviewStatus, "pending_review");
  assert.strictEqual(sections.find((s) => s.id === ids.C).reviewStatus, "normal");

  // 第三段同一音轨也出错：故障带连着扩展，带 id 不变
  const bandId = bands[0].id;
  const i3 = (await addIssue("C", 5)).data;
  bands = (await api("GET", `/tunes/${tune.id}/fault-bands`)).body.data;
  assert.strictEqual(bands.length, 1);
  assert.strictEqual(bands[0].id, bandId);
  assert.deepStrictEqual(bands[0].sectionIds, [ids.A, ids.B, ids.C]);

  // D 与 C 拍号不相邻：D 单独出错不并入；B 上另一条音轨只一段也不成带
  const i4 = (await addIssue("D", 5)).data;
  const i5 = (await addIssue("B", 7)).data;
  bands = (await api("GET", `/tunes/${tune.id}/fault-bands`)).body.data;
  assert.strictEqual(bands.length, 1);
  assert.deepStrictEqual(bands[0].sectionIds, [ids.A, ids.B, ids.C]);

  // 进度单列：待复核区间不计入已完成
  let progress = (await api("GET", `/tunes/${tune.id}/progress`)).body.data;
  assert.deepStrictEqual(
    {
      totalSections: progress.totalSections,
      checkedSections: progress.checkedSections,
      uncheckedSections: progress.uncheckedSections,
      pendingReviewSections: progress.pendingReviewSections,
      activeFaultBands: progress.activeFaultBands,
      openIssues: progress.openIssues,
      resolvedIssues: progress.resolvedIssues,
      percent: progress.percent
    },
    { totalSections: 4, checkedSections: 0, uncheckedSections: 1, pendingReviewSections: 3, activeFaultBands: 1, openIssues: 5, resolvedIssues: 0, percent: 0 }
  );

  // 重试通过一段：A 撤下待复核，故障带缩到 B-C
  await api("PATCH", `/issues/${i1.id}/status`, { status: "resolved", note: "重打后试奏通过" });
  bands = (await api("GET", `/tunes/${tune.id}/fault-bands`)).body.data;
  assert.strictEqual(bands.length, 1);
  assert.deepStrictEqual(bands[0].sectionIds, [ids.B, ids.C]);
  sections = (await api("GET", `/tunes/${tune.id}/sections`)).body.data;
  assert.strictEqual(sections.find((s) => s.id === ids.A).reviewStatus, "normal");
  assert.strictEqual(sections.find((s) => s.id === ids.B).reviewStatus, "pending_review");

  // B 也重试通过：C、D 只剩单段问题，故障带撤下；问题记录仍保留
  await api("PATCH", `/issues/${i2.id}/status`, { status: "resolved" });
  bands = (await api("GET", `/tunes/${tune.id}/fault-bands`)).body.data;
  assert.strictEqual(bands.length, 0);
  progress = (await api("GET", `/tunes/${tune.id}/progress`)).body.data;
  assert.deepStrictEqual(
    {
      checkedSections: progress.checkedSections,
      uncheckedSections: progress.uncheckedSections,
      pendingReviewSections: progress.pendingReviewSections,
      activeFaultBands: progress.activeFaultBands,
      openIssues: progress.openIssues,
      resolvedIssues: progress.resolvedIssues,
      percent: progress.percent
    },
    { checkedSections: 1, uncheckedSections: 3, pendingReviewSections: 0, activeFaultBands: 0, openIssues: 3, resolvedIssues: 2, percent: 25 }
  );
  const allIssues = (await api("GET", `/issues?tuneId=${tune.id}`)).body.data;
  assert.strictEqual(allIssues.length, 5);
  assert.strictEqual(allIssues.filter((i) => i.status === "resolved").length, 2);
  assert.ok(allIssues.every((i) => [i1.id, i2.id, i3.id, i4.id, i5.id].includes(i.id)));

  // 曲目二：没有问题的老曲目按普通处理
  const calm = (await api("POST", "/tunes", { title: "平安老曲", stripSpec: { scale: "15音" } })).body.data;
  await api("POST", `/tunes/${calm.id}/sections`, { startBeat: 1, endBeat: 16, laneRange: "1-8", checked: true });
  await api("POST", `/tunes/${calm.id}/sections`, { startBeat: 17, endBeat: 32, laneRange: "1-8", checked: false });
  const calmProgress = (await api("GET", `/tunes/${calm.id}/progress`)).body.data;
  assert.deepStrictEqual(
    {
      checkedSections: calmProgress.checkedSections,
      uncheckedSections: calmProgress.uncheckedSections,
      pendingReviewSections: calmProgress.pendingReviewSections,
      activeFaultBands: calmProgress.activeFaultBands,
      percent: calmProgress.percent
    },
    { checkedSections: 1, uncheckedSections: 1, pendingReviewSections: 0, activeFaultBands: 0, percent: 50 }
  );

  // 曲目三：音轨不在区间音轨范围内，即使拍号相邻也不成带
  const outOfRange = (await api("POST", "/tunes", { title: "超轨测试曲", stripSpec: { scale: "20音" } })).body.data;
  const s1 = (await api("POST", `/tunes/${outOfRange.id}/sections`, { startBeat: 1, endBeat: 32, laneRange: "1-10" })).body.data;
  const s2 = (await api("POST", `/tunes/${outOfRange.id}/sections`, { startBeat: 33, endBeat: 64, laneRange: "1-10" })).body.data;
  await api("POST", "/issues", { tuneId: outOfRange.id, sectionId: s1.id, type: "错孔", lane: 15, description: "超轨问题1" });
  await api("POST", "/issues", { tuneId: outOfRange.id, sectionId: s2.id, type: "错孔", lane: 15, description: "超轨问题2" });
  assert.strictEqual((await api("GET", `/tunes/${outOfRange.id}/fault-bands`)).body.data.length, 0);

  // 分析与复核状态确实写进了数据文件
  const persisted = JSON.parse(fs.readFileSync(process.env.DB_FILE, "utf8"));
  assert.ok(Array.isArray(persisted.faultBands));
  assert.ok(persisted.sections.every((s) => s.reviewStatus === "normal" || s.reviewStatus === "pending_review"));

  await new Promise((resolve) => server.close(resolve));
  fs.unlinkSync(process.env.DB_FILE);
  console.log("全部测试通过");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
