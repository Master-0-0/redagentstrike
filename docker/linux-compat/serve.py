"""Expose the lab's loopback services through container-facing TCP relays."""
import asyncio
import signal
import subprocess


async def relay(reader, writer, destination):
    remote_writer = None
    tasks = []
    try:
        remote_reader, remote_writer = await asyncio.open_connection('127.0.0.1', destination)

        async def copy(source, target):
            while data := await source.read(65536):
                target.write(data)
                await target.drain()

        tasks = [asyncio.create_task(copy(reader, remote_writer)),
                 asyncio.create_task(copy(remote_reader, writer))]
        await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
    except (ConnectionError, OSError):
        pass
    finally:
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        writer.close()
        if remote_writer:
            remote_writer.close()


async def main():
    stopped = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGTERM, signal.SIGINT):
        loop.add_signal_handler(sig, stopped.set)
    servers = []
    try:
        for exposed, internal in ((15173, 5173), (13081, 3081), (18787, 8787)):
            server = await asyncio.start_server(
                lambda r, w, port=internal: relay(r, w, port), '0.0.0.0', exposed)
            servers.append(server)
        print('Container ports ready: 15173 -> UI, 13081 -> Harness, 18787 -> API', flush=True)
        await stopped.wait()
    finally:
        for server in servers:
            server.close()
        await asyncio.gather(*(server.wait_closed() for server in servers))


if __name__ == '__main__':
    try:
        subprocess.run(['/app/start.sh'], cwd='/app', check=True)
        asyncio.run(main())
    finally:
        subprocess.run(['/app/stop.sh'], cwd='/app', timeout=90)
