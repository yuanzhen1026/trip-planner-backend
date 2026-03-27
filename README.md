# Trip Backend

## 作用

这个服务负责替 App 调用豆包接口，真实 `DOUBAO_API_KEY` 只保存在服务器环境变量里，不进入 iOS 客户端。

## 本地启动

1. 安装 Node.js 18 或更新版本
2. 复制 `.env.example`，把 `DOUBAO_API_KEY` 换成你自己的真实 key
3. 在当前目录运行：

```bash
export DOUBAO_API_KEY=你的真实key
export PORT=8787
node server.mjs
```

## 接口

- `GET /health`
- `POST /generate-trip`

请求体：

```json
{
  "userInput": "目的地：东京，天数：4天，偏好：美食、拍照"
}
```

返回：

```json
{
  "result": "{...行程 JSON 字符串...}"
}
```

## iOS 配置

在 iOS target 的 `Info.plist` 生成配置里写入：

- `AI_SERVICE_BASE_URL`

示例：

- 本地模拟器调试：`http://127.0.0.1:8787`
- 局域网真机调试：`http://你的电脑局域网IP:8787`
- 线上环境：`https://你的域名`
