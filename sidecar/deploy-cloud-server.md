# 公网云服务器部署

此方案不需要 Cloudflare Tunnel，也不改变 `emcdb.com` 的现有 DNS 托管。只需在当前 DNS 服务商新增一个 `choice-sidecar` 子域名。

## 1. 服务器准备

建议使用一台受信的 Linux 云服务器（Ubuntu 22.04/24.04，固定公网 IPv4），只开放 TCP 22、80、443。把服务器公网 IP 添加为：

```text
choice-sidecar.emcdb.com  A  <服务器公网IPv4>
```

不要把 Choice SDK 端口直接暴露到公网。服务器安装 Python、Caddy，并把官方 Linux `EMQuantAPI_Python` SDK 上传到 `/opt/EMQuantAPI_Python`。SDK 的账号令牌只在服务器本地按官方方式配置，不上传 Git。

## 2. 安装与文件

```bash
sudo useradd --system --home /var/lib/qijian-choice --create-home choice || true
sudo mkdir -p /opt/qijian-sidecar /etc/qijian
sudo chown -R choice:choice /var/lib/qijian-choice
sudo cp sidecar/choice_history_sidecar.py /opt/qijian-sidecar/sidecar/
sudo cp sidecar/choice-history.service.example /etc/systemd/system/choice-history.service
```

创建 `/etc/qijian/choice-history.env`（权限必须为 600）：

```text
CHOICE_SIDECAR_TOKEN=<随机生成的长令牌>
```

```bash
sudo chmod 600 /etc/qijian/choice-history.env
```

将 `Caddyfile.example` 安装为 Caddy 配置后启动：

```bash
sudo cp sidecar/Caddyfile.example /etc/caddy/Caddyfile
sudo systemctl enable --now caddy
sudo systemctl daemon-reload
sudo systemctl enable --now choice-history
```

先检查：

```bash
curl -fsS https://choice-sidecar.emcdb.com/health
```

## 3. EdgeOne 配置

在生产环境变量中填写：

```text
EASTMONEY_CHOICE_HISTORY_API_URL=https://choice-sidecar.emcdb.com/history
EASTMONEY_CHOICE_HISTORY_TOKEN=<与服务器 CHOICE_SIDECAR_TOKEN 完全相同>
```

保存并重新部署，然后在“期鉴”私有版测试 `AU0.SHF` 日线。授权历史行只返回给私有会话；实时/分钟接口仍保持关闭。

如果服务器尚未完成官方 SDK 登录，sidecar 会返回 provider_error；不要用 Choice 令牌替代桥接令牌，也不要把任一令牌写入仓库。
