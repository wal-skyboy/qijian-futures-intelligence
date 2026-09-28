# Choice 历史 sidecar

这是一个只读适配器：在已安装官方 `EMQuantAPI_Python` 的本人 Mac/受信主机上调用 `c.csd`，供“期鉴”私有版读取历史日/周/月/年序列。它不抓取东方财富桌面端、不执行交易，也不会把 Choice 令牌返回给网页。

## 本机启动

```bash
cd /path/to/qijian-futures-intelligence
export EMQUANT_PYTHON_ROOT="/Users/apple/Downloads/EMQuantAPI_Python/python3"
export CHOICE_SIDECAR_TOKEN="另生成一个仅供桥接使用的随机长令牌"
source /Users/apple/choice-venv/bin/activate
python3 sidecar/choice_history_sidecar.py
```

启动后本机自检：

```bash
curl -sS http://127.0.0.1:8787/health
curl -sS -X POST http://127.0.0.1:8787/history \
  -H "Authorization: Bearer $CHOICE_SIDECAR_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"function":"csd","codes":["AU0.SHF"],"indicators":"close","startdate":"2026-09-01","enddate":"2026-09-26","options":"Period=1,Order=1,AdjustFlag=1,Market=CNFESF,Ispandas=0"}'
```

生产接入时，将 `/history` 放在你控制的 HTTPS 反向代理/隧道后，并只允许 EdgeOne 服务器访问；不要把 `127.0.0.1`、Choice SDK 端口或个人令牌直接暴露到公网。随后在 EdgeOne 生产环境填写：

- `EASTMONEY_CHOICE_HISTORY_API_URL=https://你的受信域名/history`
- `EASTMONEY_CHOICE_HISTORY_TOKEN=与 CHOICE_SIDECAR_TOKEN 相同的值`

变量保存后重新部署，在“期鉴”本人私有版点击“测试授权历史数据”。公开访客不会获得授权历史行。实时/分钟权限不在此 sidecar 内，仍保持关闭。
