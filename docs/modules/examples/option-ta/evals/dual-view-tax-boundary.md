---
name: dual-view-tax-boundary
uses: knowledge, tools/ledger
expect: NOT_IMPLEMENTED, NOT_READ, 有效成本, QCC, 待确认, 14.2, 14.3
---
只检验option-ta账本与税务的P2安全边界，不求税额或股票成本数值、不写入任何记录。请分别实际调用ledger的chain和tax视图，tax_year都为2026，报告工具状态及database字段；不要把未读库当作空账本或今年收益为零。
情境是同一账户的put经过多次Roll后被指派，随后考虑对这批股票开CC；费用、完整股票批次和开CC时的行情快照均未提供。查本模块税务知识，引用memo第14.2、14.3节以及材料版本日期，简短说明：两个视图是否另存两套盈亏原账；Roll组是否影响税务视图；链的有效成本能否直接当股票税务成本；这个CC（即使标的是ETF）的QCC状态及缺的数据；wash sale或跨式标记能否据此自动禁扣、递延或改成本。
区分第一版目标与本轮未实现能力，不自行代算税务，不声称本轮联网核验了IRS，不追问。
