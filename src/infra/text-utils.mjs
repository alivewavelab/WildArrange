// 字符串集合小工具的单一 owner（ARC-007 收敛）；各分区不得再本地复刻。
export function uniqueStrings(values) {
  return [...new Set(values.filter((value) => typeof value === "string" && value.length > 0))];
}
