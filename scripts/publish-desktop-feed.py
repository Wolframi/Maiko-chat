#!/usr/bin/env python3
"""Receive a release tar on stdin through a restricted SSH key."""
import base64
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile

DESTINATION = Path('/var/www/maiko-desktop-updates')
MAX_BYTES = 400 * 1024 * 1024


def announce(project, version):
    directory = project / 'site' / 'data'
    directory.mkdir(parents=True, exist_ok=True)
    pending = directory / '.desktop-release.json.pending'
    pending.write_text(json.dumps({'version': version}) + '\n')
    pending.chmod(0o644)
    os.replace(pending, directory / 'desktop-release.json')


def metadata(text):
    version = re.search(r'^version: (\d+\.\d+\.\d+)\s*$', text, re.M).group(1)
    installer = f'Maiko-Setup-{version}.exe'
    assert re.search(r'^path: (.+)$', text, re.M).group(1).strip() == installer
    assert re.findall(r'^\s*- url: (.+)$', text, re.M) == [installer]
    hashes = re.findall(r'^\s*sha512: (\S+)\s*$', text, re.M)
    assert len(hashes) == 2 and hashes[0] == hashes[1]
    size = int(re.search(r'^\s*size: (\d+)\s*$', text, re.M).group(1))
    return version, installer, hashes[0], size


def publish():
    DESTINATION.mkdir(mode=0o755, parents=True, exist_ok=True)
    with open(DESTINATION / '.publish.lock', 'a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        with tempfile.TemporaryDirectory(prefix='maiko-release-', dir='/var/tmp') as temporary:
            stage = Path(temporary)
            total = 0
            names = set()
            with tarfile.open(fileobj=sys.stdin.buffer, mode='r|*') as archive:
                for member in archive:
                    name = member.name[2:] if member.name.startswith('./') else member.name
                    if not member.isfile() or not re.fullmatch(r'latest\.yml|Maiko-Setup-\d+\.\d+\.\d+\.exe(?:\.blockmap)?', name):
                        raise ValueError('Unexpected archive entry')
                    if name in names or member.size <= 0:
                        raise ValueError('Duplicate or empty artifact')
                    names.add(name)
                    total += member.size
                    if total > MAX_BYTES or len(names) > 3:
                        raise ValueError('Release exceeds upload limits')
                    with archive.extractfile(member) as source, (stage / name).open('wb') as target:
                        shutil.copyfileobj(source, target)
            version, installer, expected_hash, expected_size = metadata((stage / 'latest.yml').read_text())
            if names != {'latest.yml', installer, installer + '.blockmap'}:
                raise ValueError('Incomplete release')
            content = stage / installer
            digest = hashlib.sha512()
            with content.open('rb') as source:
                for block in iter(lambda: source.read(1024 * 1024), b''):
                    digest.update(block)
            if content.stat().st_size != expected_size or base64.b64encode(digest.digest()).decode() != expected_hash:
                raise ValueError('Installer checksum mismatch')
            previous = DESTINATION / 'latest.yml'
            if previous.exists():
                old_version, _, old_hash, _ = metadata(previous.read_text())
                if tuple(map(int, version.split('.'))) < tuple(map(int, old_version.split('.'))):
                    raise ValueError('Refusing an older release')
                if version == old_version and expected_hash != old_hash:
                    raise ValueError('Refusing to replace an existing version')
            # S3 artifacts are verified and its manifest is published last.
            # This runs under the same SSH publication lock as the bridge feed.
            project = Path(__file__).resolve().parent.parent
            config = project / 'site' / '.desktop-s3-storage.json'
            if config.exists():
                subprocess.run(['node', '--import', 'tsx', 'scripts/publish-desktop-s3.ts', str(stage)],
                               cwd=project / 'site', check=True)
            elif tuple(map(int, version.split('.'))) >= (1, 1, 14):
                raise ValueError('Desktop S3 configuration is required for this release')
            # The server feed stays on the bridge version. Older applications
            # install it once and then switch to the private S3-backed feed.
            if tuple(map(int, version.split('.'))) > (1, 1, 14):
                announce(project, version)
                print(f'Published desktop update {version} to S3; server bridge remains 1.1.14.')
                return
            # Keep earlier installers for in-progress and differential downloads.
            for name in [installer, installer + '.blockmap', 'latest.yml']:
                pending = DESTINATION / ('.' + name + '.pending')
                shutil.copyfile(stage / name, pending)
                pending.chmod(0o644)
                os.replace(pending, DESTINATION / name)
            announce(project, version)
            print(f'Published desktop update {version}; SHA-512 verified.')


if __name__ == '__main__':
    publish()
