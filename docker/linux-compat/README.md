# Debian Linux 兼容性测试镜像

这是完整源码构建和运行验证用镜像，包含测试依赖、Chromium、中文字体及 Harness Linux 沙箱程序。默认运行测试后退出，不是对外提供服务的生产镜像。

## 构建及测试

在仓库根目录执行，先确保 `deepseek-harness` 子模块完整：

```sh
docker build --platform linux/arm64 \
  --build-arg DSH_CLIENT_COMMIT_HASH="$(git -C deepseek-harness rev-parse HEAD)" \
  -f docker/linux-compat/Dockerfile \
  -t ct-st3-linux-compat:debian12 .

mkdir -p docs/verification/linux-compat
docker run --rm \
  --mount type=bind,src="$PWD/docs/verification/linux-compat",dst=/results \
  ct-st3-linux-compat:debian12
```

本轮测试架构为 ARM64；在 AMD64 主机可改为 `--platform linux/amd64` 重新验证，当前报告不代表 AMD64 已通过。

默认测试包括后端 pytest、三个业务插件测试、捕获诊断、真实 Chromium 截图、沙箱读写隔离、工作台/Harness 启停和页面渲染。退出码非零表示至少一组检查失败；详见 `/results/status.txt` 和各项日志。Python 与 mitmproxy 依赖版本也会输出到结果目录。Python 依赖仍遵循项目版本范围，未来重建可能解析到不同版本。

镜像不挂载宿主的 `~/.dsh`、凭据或项目数据。测试数据写在一次性容器内，仅结果目录挂载到宿主。首次页面的 Harness 内测提示会正常出现；没有配置模型密钥，也不会调用真实模型。

## 镜像分层

- `baseline`：按项目源码构建，安装 Chromium 和中文字体；保留未补 `lsof`、bubblewrap、Landlock 原生程序时的环境。
- 默认最终阶段：补 `lsof`、bubblewrap、musl-tools，构建本架构 Landlock 程序，安装四个插件及 Cairn preset，再执行完整验证。

需要复现缺少系统工具的环境时，在构建命令中添加 `--target baseline` 并使用单独镜像标签。默认测试入口在 baseline 中只跑后端与插件测试；完整运行脚本位于本目录，可只读挂载进去执行。

`runtime-smoke.py` 使用正式平台判断验证 HTTP/HTTPS → mitmproxy → addon → DuckDB、拦截修改放行、丢弃、重放及捕获启停。HTTPS 使用本地测试证书并显式信任测试 CA，不关闭证书校验。`harness-smoke.sh` 同时验证托管 Harness 的代理注入与撤销。

Dockerfile 专用忽略文件排除了宿主 node_modules、venv、构建产物、Git 元数据、环境文件和后端数据。Harness 构建通过官方 `DSH_CLIENT_COMMIT_HASH` 参数接收版本；前端同时复制其依赖的 `dsh-cairn-search/src`。

## 已知限制

- 网络捕获支持 macOS/Linux；完整验证结果见 [Linux 捕获修复记录](../../docs/verification/linux-capture/README.md)。
- 默认监听 `127.0.0.1`，单独添加 `docker run -p` 不能让宿主访问容器中的服务。需要另做监听地址、前端 Harness URL 和代理配置适配。
- bubblewrap 在本轮默认 Docker 权限下不能创建 namespace；Landlock 在本轮 LinuxKit 内核上通过。其他宿主内核可能不同，测试会如实失败；没有使用特权容器或关闭 seccomp。
- 镜像以 root 做兼容性实验，生产用户权限、持久化与服务入口不属于本镜像的验证范围。

完整证据和结论见 [兼容性报告](../../docs/verification/linux-compat/README.md)。

## 从宿主浏览器访问

已有镜像时，可使用附带的 Compose 配置启动常驻工作台：

```sh
docker compose -f docker/linux-compat/compose.yaml up -d
```

打开 `http://127.0.0.1:5173/`。宿主 5173、3081、8787 分别映射 UI、Harness 和 API，仅绑定宿主回环地址。`serve.py` 在容器中增加 TCP 转发端口，保留应用内部的回环地址与 Harness ready URL，支持 HTTP 和 WebSocket 透传。已经从宿主浏览器验证工作台及内嵌 Harness 加载成功。

数据保存在 Compose 命名卷 `workbench-data`、`harness-home`；模型设置需在这个容器的工作台中配置。更新后的镜像已支持 Linux 网络捕获。

```sh
# 查看状态和日志
docker compose -f docker/linux-compat/compose.yaml ps
docker compose -f docker/linux-compat/compose.yaml logs -f

# 停止并删除容器，保留数据卷
docker compose -f docker/linux-compat/compose.yaml down
```
