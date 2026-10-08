#!/bin/bash
# Start the local workbench; stop.sh uses the same process bookkeeping.
set -euo pipefail
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PYTHON="$ROOT/backend/.venv/bin/python"
if [[ ! -x "$PYTHON" ]]; then
  echo '缺少 backend/.venv，请先按 README 完成后端安装。' >&2
  exit 1
fi
exec "$PYTHON" - "$ROOT" "$@" <<'PY'
import fcntl
import json
import os
from pathlib import Path
import shutil
import signal
import socket
import subprocess
import sys
import time
import urllib.request

root = Path(sys.argv[1])
os.chdir(root)
runtime = root / '.run'
runtime.mkdir(exist_ok=True)
lock = (runtime / 'lock').open('a')
try:
    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
except BlockingIOError:
    sys.exit('另一个启停脚本正在运行，请稍后重试。')
state_file = runtime / 'processes.json'
state = json.loads(state_file.read_text()) if state_file.exists() else {}


def identity(pid):
    result = subprocess.run(['ps', '-p', str(pid), '-o', 'lstart=', '-o', 'stat='],
                            capture_output=True, text=True)
    fields = result.stdout.strip().split()
    if result.returncode or not fields or fields[-1].startswith('Z'):
        return None
    return ' '.join(fields[:-1])


def alive(info):
    return identity(info['pid']) == info['started']


def save():
    temp = state_file.with_suffix('.tmp')
    temp.write_text(json.dumps(state))
    temp.replace(state_file)


def stop(names):
    failed = False
    for name in names:
        info = state.get(name)
        if not info:
            continue
        if alive(info):
            os.kill(info['pid'], signal.SIGTERM)
            deadline = time.monotonic() + 30
            while alive(info) and time.monotonic() < deadline:
                time.sleep(0.2)
            if alive(info):
                print(f'{name} 未能在 30 秒内退出；保留进程记录，请检查日志后重试。', file=sys.stderr)
                failed = True
                continue
        state.pop(name, None)
        save()
        print(f'{name} 已停止。')
    return not failed


if sys.argv[2:] == ['--stop']:
    if not state:
        print('项目未通过脚本启动，或已经停止。')
    sys.exit(0 if stop(['frontend', 'backend']) else 1)
if sys.argv[2:]:
    sys.exit('用法：./start.sh 或 ./stop.sh')

created = []
try:
    node = shutil.which('node')
    vite = root / 'web-ui/node_modules/vite/bin/vite.js'
    if not node or not vite.exists():
        raise RuntimeError('缺少 Node.js 或前端依赖，请按 README 安装 Node.js 并在 web-ui 执行 npm install。')
    from workbench.config import load_settings
    settings = load_settings()
    if settings.manage_dsh and shutil.which('lsof') is None:
        raise RuntimeError('Error: required tool lsof not found')
    env = os.environ.copy()
    env['WORKBENCH_STOP_DSH_ON_EXIT'] = '1'
    api_host = settings.api_host
    probe_host = '127.0.0.1' if api_host == '0.0.0.0' else api_host
    api_url = f'http://{probe_host}:{settings.api_port}'
    env.setdefault('VITE_API_ORIGIN', api_url)
    env.setdefault('VITE_DSH_ORIGIN', f'http://{settings.dsh_host}:{settings.dsh_port}')
    services = [
        ('backend', [sys.executable, '-m', 'workbench'], root,
         api_host, settings.api_port, api_url + '/health'),
        ('frontend', [node, str(vite)], root / 'web-ui',
         '127.0.0.1', 5173, 'http://127.0.0.1:5173/'),
    ]
    # Check every port before starting either service. Never take over unrelated processes.
    for name, command, cwd, host, port, url in services:
        if name in state and alive(state[name]):
            continue
        with socket.socket() as sock:
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            try:
                sock.bind((host, port))
            except OSError as exc:
                raise RuntimeError(f'{name} 的端口 {port} 已被占用或不可绑定；请先停止原有服务。') from exc
    if settings.manage_dsh and not ('backend' in state and alive(state['backend'])):
        with socket.socket() as sock:
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            try:
                sock.bind((settings.dsh_host, settings.dsh_port))
            except OSError as exc:
                raise RuntimeError(f'Harness 端口 {settings.dsh_port} 已占用，请先停止原有 Harness。') from exc
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    for name, command, cwd, host, port, url in services:
        if name in state and alive(state[name]):
            print(f'{name} 已在运行。')
            continue
        with (runtime / f'{name}.log').open('ab') as log:
            proc = subprocess.Popen(command, cwd=cwd, env=env, stdin=subprocess.DEVNULL,
                                    stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
        stamp = identity(proc.pid)
        if stamp is None:
            raise RuntimeError(f'{name} 启动后立即退出，请查看 {runtime / (name + ".log")}')
        state[name] = {'pid': proc.pid, 'started': stamp}
        created.append(name)
        save()
        deadline = time.monotonic() + 90
        while time.monotonic() < deadline:
            if proc.poll() is not None:
                raise RuntimeError(f'{name} 启动失败，请查看 {runtime / (name + ".log")}')
            try:
                with opener.open(url, timeout=2) as response:
                    if response.status == 200 and (name != 'backend' or json.load(response).get('ok')):
                        break
            except OSError:
                pass
            time.sleep(0.3)
        else:
            raise RuntimeError(f'{name} 启动超时，请查看 {runtime / (name + ".log")}')
        if name == 'backend' and settings.manage_dsh:
            request = urllib.request.Request(
                api_url + '/capture', data=b'{"enabled": false}',
                headers={'Content-Type': 'application/json'}, method='POST')
            with opener.open(request, timeout=65) as response:
                result = json.load(response)
            if result.get('error') or not result.get('capture', {}).get('harness', {}).get('pid'):
                raise RuntimeError('Harness 启动失败，请查看后端日志及 WORKBENCH_DATA/dsh-web.log。')
        print(f'{name} 已就绪。', flush=True)
    print(f'项目已启动：http://127.0.0.1:5173\n日志目录：{runtime}\n停止：{root / "stop.sh"}')
except (Exception, KeyboardInterrupt) as exc:
    print(f'启动失败：{exc}', file=sys.stderr)
    stop(list(reversed(created)))
    sys.exit(1)
PY
