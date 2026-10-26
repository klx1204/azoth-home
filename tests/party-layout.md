# 水银 FC 存档：队伍布局

上游 wiki 没有记录队伍（party）位置。下面是从真实 FC 1.33 存档逆向并验证过的结果，
用于 `src/bridge.js` 的 `getParty()` / `updatePartyMon()`。

## 结论

```
SaveBlock1 + 0x3C            party[0]
SaveBlock1 + 0xA0            party[1]
...                          +0x64 (100) 每一项
SaveBlock1 + 0x28C           party[5]
```

- 单项 100 字节，前 58 字节与箱子个体完全相同（`parseBoxMonCfru` 可直接解析）。
- 队伍单项的字段偏移：

| 块内偏移 | 内容 |
|---|---|
| 0x00–0x39 | 58 字节 box mon（与箱子同一套 codec） |
| 0x3A–0x4F | 战斗状态等字段（未完全标识，保持原样） |
| 0x50 | 等级 u8（与 EXP 应保持一致） |
| 0x51 | 病毒/保留 u8 |
| 0x52 | 当前 HP u16 |
| 0x54 | 最大 HP u16 |
| 0x56 | 攻击 u16 |
| 0x58 | 防御 u16 |
| 0x5A | 速度 u16 |
| 0x5C | 特攻 u16 |
| 0x5E | 特防 u16 |
| 0x60–0x63 | 保留 |

整个队伍区位于 `section 1`（SaveBlock1 的第一段），所以写回时只需要重算 section 1 的
checksum，上游的 `writeBoxMonBytes` / `writeSection` 会自动处理。

## 为什么编辑限制在招式/道具/昵称

`0x50` 的等级和 `0x52` 起的 HP/能力值是游戏直接读取的权威数据，不会在加载时按 EXP
重算。如果改了物种、等级、IV 或 EV 而不同步重算这些值，游戏里会出现「Lv.50 但 HP 仍是
47」这类不一致。

因此队伍编辑只放开了不影响能力值的字段：

- 招式、携带道具、昵称、梦特槽（IV 字的 bit31，不改变 IV 数值）。

物种 / 等级 / IV / EV 在队伍里锁定；需要改这些时，先在箱子里改，再在游戏内换入队伍。

## 验证方法

`tests/party.mjs` 用真实存档跑完整闭环：

```
AZOTH_TEST_SAV=<save.sav> node tests/party.mjs
```

它会上传存档 → 改第一只队伍成员的招式 → 点上游的「保存 HOME 和 SAV」→ 下载生成的文件
→ 重新上传解析，断言招式变化且其余成员不变。

用 Python 对比原始文件与生成文件，正常只应有 2 字节差异：招式字节 + section 1 的
checksum。

## 如果以后布局变了

上游改版后，用差分法重新定位：

1. 在游戏内把队伍第 1、2 只互换，导出第二份存档。
2. 逐字节 diff，连续 6 个 100 字节块整体移位的位置就是 party 起点。
3. 用「升级一次」「受一次伤」分别导出，定位 `0x50`（等级）、`0x52`（HP）、`0x54`（最大 HP）。
4. 用箱子数据校正前 58 字节的字段偏移（species @28、item @30、exp @32）。

`scripts/analyze_sav.py` 可以把存档解析成 SaveBlock1 并列出这些区域，方便手工比对。
