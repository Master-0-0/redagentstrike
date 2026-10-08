"""Read only regular files through anchored directory descriptors.

openat + O_NOFOLLOW at every component prevents symlink and rename races.
No shell is invoked; stdout carries only bytes from the already-opened object.
"""
import os
import stat
import sys


def main():
    root, relative, limit = sys.argv[1], sys.argv[2], int(sys.argv[3])
    parts = relative.split('/')
    if relative.startswith('/') or any(p in ('', '.', '..') for p in parts):
        raise ValueError('path_not_allowed')
    fd = os.open('/', os.O_RDONLY | os.O_DIRECTORY)
    try:
        for part in root.split('/') + parts[:-1]:
            if not part:
                continue
            new = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = new
        source = os.open(parts[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd)
        try:
            meta = os.fstat(source)
            if not stat.S_ISREG(meta.st_mode):
                raise ValueError('path_not_allowed')
            if meta.st_size > limit:
                raise ValueError('payload_too_large')
            total = 0
            while True:
                block = os.read(source, 65536)
                if not block:
                    break
                total += len(block)
                if total > limit:
                    raise ValueError('payload_too_large')
                sys.stdout.buffer.write(block)
        finally:
            os.close(source)
    finally:
        os.close(fd)

try:
    main()
except FileNotFoundError:
    sys.stderr.write('file_not_found')
    sys.exit(1)
except Exception as error:
    sys.stderr.write(str(error) if isinstance(error, ValueError) else 'path_not_allowed')
    sys.exit(1)
