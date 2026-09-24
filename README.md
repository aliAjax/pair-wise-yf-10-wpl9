# 手摇风琴纸带打孔API

纯后端零依赖Node服务，使用 `data/db.json` 持久化曲目、纸带区间、试奏问题与故障带。

代码分三层维护：

- `store.js`：存储。读写 JSON、老数据结构迁移、生成 id。
- `faultBands.js`：计算。按拍号和音轨分析故障带（纯函数），并把分析/复核状态对账到数据，不接触 HTTP。
- `server.js`：接口。只做请求解析与响应编排。

## 启动

```bash
PORT=3019 node server.js
```

启动时会自动把已有数据补齐分析与复核状态：没有跨段问题的老曲目维持普通处理。

## 故障带规则

1. 区间相邻：同一曲目、按拍号排序后相接或重叠（中间至多空 1 拍，允许重打重叠），且音轨范围有交集；
2. 同一位置：相邻两区间各有一条**未解决**问题，音轨相同且拍号相差不超过 1 拍（跨接缝的同一个孔），即在两区间间连边；
3. 连通分量包含至少 2 个区间即归为一条故障带（三段链式同位置出错会并成一条）；
4. 带内区间 `reviewState` 转为 `pending_review`，复核进度单列；
5. 重试通过（问题置为 `resolved`）后重新分析，连边全部消失即撤下故障带（`status=withdrawn` 留痕），**原问题记录始终保留**；同一位置复发时原故障带复活，id 不变。

登记问题、关闭问题后都会自动重算；也可用分析接口手动触发。

## 区间复核状态

- `reviewState`：`normal`（普通）/ `pending_review`（在故障带内待复核）；
- `faultBandId`：所属在役故障带 id，无则为 `null`。

## 主要接口

- `GET /health`
- `GET /tunes`
- `POST /tunes`
- `GET /tunes/:id/progress`（含 `review` 单列：故障带数、待复核区间数、带内未解决问题数）
- `GET /tunes/:id/sections`
- `POST /tunes/:id/sections`
- `GET /tunes/:id/unchecked-sections`
- `PATCH /sections/:id/check`
- `GET /issues?tuneId=&status=`
- `POST /issues`（登记后自动分析，响应附带 `review` 与当前故障带）
- `PATCH /issues/:id/status`（重试通过撤下故障带，原问题保留）
- `GET /tunes/:id/fault-bands?include=withdrawn`（默认只返回在役故障带）
- `POST /tunes/:id/fault-bands/analyze`（手动重算）

## 闭环示例

```bash
curl http://127.0.0.1:3019/tunes/tune_demo/progress

# 接缝两侧同一音轨各登记一个问题 -> 自动归成故障带
curl -X POST http://127.0.0.1:3019/issues \
  -H 'Content-Type: application/json' \
  -d '{"tuneId":"tune_demo","sectionId":"section_demo_2","type":"错孔","beat":64,"lane":12,"description":"接缝处第64拍12轨错孔"}'

# 重试通过 -> 撤下故障带，问题记录仍在
curl -X PATCH http://127.0.0.1:3019/issues/issue_demo/status \
  -H 'Content-Type: application/json' \
  -d '{"status":"resolved","note":"重打后试奏通过"}'
```
