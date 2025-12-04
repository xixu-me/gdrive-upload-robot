# Google Drive 上传机器人

一个基于 Cloudflare Workers 构建的 Telegram 机器人，会自动把发送给它的文件和照片上传到 Google Drive。

## 功能特性

* 📁 **自动文件上传**：将发送给机器人的任意文档自动上传到 Google Drive
* 📷 **支持照片**：支持照片上传并自动命名
* ☁️ **无服务器架构**：运行在 Cloudflare Workers 上，零服务器运维成本
* 🔒 **安全**：使用 Google 服务账号（Service Account）进行身份验证
* 📱 **实时通知**：向管理员发送上传成功的确认消息

## 工作原理

1. 用户向 Telegram 机器人发送文件或照片
2. 机器人从 Telegram 服务器下载该文件
3. 使用服务账号凭据与 Google Drive 进行身份验证
4. 将文件上传到指定的 Google Drive 文件夹
5. 向管理员发送确认消息

## 快速开始

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/xixu-me/gdrive-upload-robot)

使用上面的 “Deploy to Cloudflare” 按钮可以获得最快的部署体验。

## 安装配置

### 前置条件

在开始之前，请确保你已经具备：

* 一个 [Cloudflare 账号](https://dash.cloudflare.com/sign-up)（提供免费套餐）
* 已安装 [Node.js](https://nodejs.org/)（版本 16 或更高）
* 本机已安装 Git

### 第 1 步：配置 Google Drive

1. **创建 Google Cloud 项目**

   * 访问 [Google Cloud Console](https://console.cloud.google.com/)
   * 创建一个新项目或选择已有项目
   * 记下你的项目 ID

2. **启用 Google Drive API**

   * 在 Google Cloud Console 中，进入 “APIs & Services” > “Library”
   * 搜索 “Google Drive API” 并点击 “Enable（启用）”

3. **创建服务账号（Service Account）**

   * 进入 “APIs & Services” > “Credentials”
   * 点击 “Create Credentials” > “Service Account”
   * 填写服务账号信息并创建
   * 点击刚创建的服务账号
   * 前往 “Keys” 标签页 > “Add Key” > “Create New Key”
   * 选择 JSON 格式并下载文件
   * **务必妥善保存该 JSON 文件——其中包含敏感凭据**

4. **配置 Google Drive 文件夹**

   * 在你的 Google Drive 中创建一个用于保存上传文件的文件夹
   * 右键该文件夹 > “共享（Share）”
   * 将服务账号的邮箱（在 JSON 文件中可找到）添加为编辑者
   * 从浏览器地址栏中复制该文件夹的 ID（例如：`https://drive.google.com/drive/folders/FOLDER_ID_HERE` 中的 `FOLDER_ID_HERE`）

### 第 2 步：配置 Telegram 机器人

1. **创建 Telegram 机器人**

   * 在 Telegram 中私聊 [@BotFather](https://t.me/botfather)
   * 发送 `/newbot` 命令
   * 按提示设置机器人名称和用户名
   * 保存 BotFather 提供的机器人 Token

2. **获取你的 Chat ID**

   * 私聊 [@userinfobot](https://t.me/userinfobot) 来获取你的 Chat ID
   * 或者给你的机器人发送一条消息，然后访问：
     `https://api.telegram.org/bot<YOUR_BOT_TOKEN>/getUpdates`
   * 在返回的数据中查找 `"chat":{"id":CHAT_ID}`

### 第 3 步：环境变量

你需要配置以下环境变量。**务必妥善保管这些变量！**

| 变量名                      | 描述                      | 示例                                             |
| ------------------------ | ----------------------- | ---------------------------------------------- |
| `TELEGRAM_BOT_TOKEN`     | 来自 BotFather 的机器人 Token | `123456789:ABCdefGHIjklMNOpqrsTUVwxyz`         |
| `GOOGLE_DRIVE_FOLDER_ID` | Google Drive 文件夹 ID     | `1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms` |
| `ADMIN_CHAT_ID`          | 你的 Telegram Chat ID     | `123456789`                                    |
| `GOOGLE_CREDENTIALS`     | 服务账号 JSON（转成字符串）        | `{"type":"service_account",...}`               |

### 第 4 步：本地环境搭建

1. **克隆仓库**

   ```bash
   git clone https://github.com/xixu-me/gdrive-upload-robot.git
   cd gdrive-upload-robot
   ```

2. **安装依赖**

   ```bash
   npm install
   ```

3. **登录 Cloudflare**

   ```bash
   npx wrangler login
   ```

4. **配置机密变量（用于生产环境）**

   ```bash
   # 添加机器人 Token
   npx wrangler secret put TELEGRAM_BOT_TOKEN

   # 添加 Google Drive 文件夹 ID
   npx wrangler secret put GOOGLE_DRIVE_FOLDER_ID

   # 添加你的 Chat ID
   npx wrangler secret put ADMIN_CHAT_ID

   # 添加 Google 凭据（粘贴整个 JSON 内容）
   npx wrangler secret put GOOGLE_CREDENTIALS
   ```

### 第 5 步：部署

1. **部署到 Cloudflare Workers**

   ```bash
   npx wrangler deploy
   ```

2. **配置 Telegram Webhook**

   ```bash
   curl -X POST "https://api.telegram.org/bot<YOUR_BOT_TOKEN>/setWebhook" \
        -H "Content-Type: application/json" \
        -d '{"url": "https://your-worker.your-subdomain.workers.dev"}'
   ```

   将 `<YOUR_BOT_TOKEN>` 替换为你的实际机器人 Token，并把 URL 换成你 Worker 的实际地址。

3. **测试机器人**

   * 向你的 Telegram 机器人发送一个文件或照片
   * 检查该文件是否出现在你的 Google Drive 文件夹中
   * 你应当会收到一条确认消息

### 故障排查

* **机器人没有响应**：检查 Webhook 是否配置正确
* **上传失败**：确认 Google Drive 文件夹权限和服务账号访问权限是否正确
* **身份验证错误**：检查所有环境变量是否已正确设置
* **本地开发调试**：可以使用 `npx wrangler dev` 进行本地测试

## API 接口

Worker 期望接收来自 Telegram Webhook 的 POST 请求，Payload 结构如下：

### 文档上传

```json
{
  "message": {
    "document": {
      "file_id": "telegram_file_id",
      "file_name": "document.pdf"
    }
  }
}
```

### 照片上传

```json
{
  "message": {
    "photo": [
      {
        "file_id": "telegram_file_id",
        "width": 1280,
        "height": 720
      }
    ]
  }
}
```

## 安全注意事项

* 包含敏感数据的环境变量会安全地存储在 Cloudflare Workers 中
* Google 服务账号只应授予最小必要权限
* 机器人 Token 必须保密，不要提交到版本控制系统
* 在生产环境中建议实现访问频率限制（Rate Limiting）

## 许可证

本项目采用 GNU 通用公共许可证 v3.0（GNU General Public License v3.0）授权——详情见 [LICENSE](LICENSE) 文件。

## 致谢

* 基于 [Cloudflare Workers](https://workers.cloudflare.com/) 构建
* 使用 [Google Drive API](https://developers.google.com/drive/api)
* 集成 [Telegram Bot API](https://core.telegram.org/bots/api)
