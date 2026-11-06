#!/usr/bin/env python3
"""Offline production-profile release contracts. No Docker, registry or live data."""
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('gcp_update', ROOT / 'deploy/gcp/update.py')
u = importlib.util.module_from_spec(spec)
spec.loader.exec_module(u)
SHA = 'a' * 40
ID = 'sha256:' + '1' * 64
BASE = 'SHOP_HOST=shop.example\nSELLER_HOST=seller.example\nADMIN_USERNAME=owner\nSECRETS_DIR=/opt/secrets\n'
ON = 'MCP_ENABLED=1\nMCP_REDIRECT_URIS=https://client.example/callback\nMCP_V2_PRODUCTION_PROFILE=seller-operations-v1\n' + ''.join(key + '=1\n' for key in u.MCP_FLAGS)

def manifest():
    return dict(version=1,image='ghcr.io/yapweijun1996/online-shopping-backend@sha256:' + '2'*64,
                imageId=ID,revision=SHA,platform='linux/amd64',**{key:'3'*64 for key in u.CODEC_FILES})

def release():
    return dict(sha=SHA,baseline={},backend='ghcr.io/yapweijun1996/online-shopping-backend@sha256:'+'4'*64,
                frontend='ghcr.io/yapweijun1996/online-shopping-frontend@sha256:'+'5'*64,
                mcp=dict(version=1,profile=u.PROFILE,backendIdentity=ID,codec=manifest()))

class Tests(unittest.TestCase):
    def test_profile_is_complete_or_disabled_and_identity_is_not_runtime_input(self):
        with tempfile.TemporaryDirectory() as root:
            p = Path(root,'runtime.env'); f=u.Updater(root)
            p.write_text(BASE); self.assertFalse(f.mcp_enabled())
            p.write_text(BASE+ON); self.assertTrue(f.mcp_enabled())
            bad=[ON.replace(key+'=1\n',key+'=0\n') for key in ('MCP_ENABLED',*u.MCP_FLAGS)]
            bad += ['MCP_V2_PRODUCTION_PROFILE=\n', 'MCP_V2_ENABLED=1\n', ON+'MCP_V2_BACKEND_IDENTITY='+ID+'\n',
                    ON+'MCP_GENERATION_PATH=/tmp/untrusted\n',ON+'MCP_V2_MEDIA_SOCKET_PATH=/tmp/x\n']
            for value in bad:
                p.write_text(BASE+value)
                with self.assertRaises(ValueError): f.runtime()

    def test_closed_codec_and_backend_release_binding(self):
        with tempfile.TemporaryDirectory() as root:
            f=u.Updater(root); f.validate_release(release())
            for field,value in [('image','evil/image:latest'),('imageId','latest'),('revision','b'*40),('platform','linux/arm64'),('wireSha256','3'*63)]:
                r=release(); r['mcp']['codec'][field]=value
                with self.assertRaises(ValueError): f.validate_release(r)
            for mutate in [lambda r:r['mcp'].update(extra=True),lambda r:r['mcp']['codec'].update(extra=True),
                           lambda r:r['mcp'].update(backendIdentity='not-an-id'),lambda r:r['mcp']['codec'].update(image=r['backend'])]:
                r=release();mutate(r)
                with self.assertRaises(ValueError):f.validate_release(r)

    def test_publisher_identity_requires_actual_file_hash_labels_and_platform(self):
        with tempfile.TemporaryDirectory() as root:
            f=u.Updater(root); content={path:path.encode() for path in u.CODEC_FILES.values()}
            labels={'org.opencontainers.image.title':'online-shopping-media-codec','org.opencontainers.image.source':'https://github.com/'+u.REPO,'org.opencontainers.image.revision':SHA}
            for name,key in [('wire','wireSha256'),('client','clientSha256'),('lock','lockSha256')]:
                labels['shopping.media.'+name+'.sha256']=hashlib.sha256(content[u.CODEC_FILES[key]]).hexdigest()
            info=dict(Id=ID,Os='linux',Architecture='amd64',Config=dict(Labels=labels),RepoDigests=[manifest()['image']])
            with patch.object(f,'docker',side_effect=['',json.dumps(info)]) as docker:
                actual=f.codec_image(SHA,content)
            self.assertEqual(ID,actual['imageId']);self.assertEqual(SHA,actual['revision'])
            self.assertEqual('ghcr.io/yapweijun1996/online-shopping-backend:media-codec-'+SHA,docker.call_args_list[0].args[-1])
            for key in labels:
                bad=json.loads(json.dumps(info));bad['Config']['Labels'][key]='wrong'
                with patch.object(f,'docker',side_effect=['',json.dumps(bad)]):
                    with self.assertRaises(ValueError): f.codec_image(SHA,content)

    def test_source_verifies_every_boundary_blob_without_commit_tree_sha_assumption(self):
        with tempfile.TemporaryDirectory() as root:
            f=u.Updater(root); paths=(*u.MOUNTS,'src/db.js',*u.CODEC_FILES.values())
            content={p:(b'export const SCHEMA_VERSION = 34;' if p=='src/db.js' else p.encode()) for p in paths}
            entries=[dict(path=p,type='blob',mode='100644',sha=hashlib.sha1(b'blob '+str(len(b)).encode()+b'\0'+b).hexdigest()) for p,b in content.items()]
            with patch.object(u,'api',return_value=dict(sha=SHA,truncated=False,tree=entries)),patch.object(u,'request',side_effect=lambda url:content[url.split('/'+SHA+'/')[1]]):
                baseline,actual=f.source(SHA)
            self.assertEqual(34,baseline['schema']);self.assertEqual(content,actual)
            with patch.object(u,'api',return_value=dict(tree=entries)),patch.object(u,'request',return_value=b'corrupt'):
                with self.assertRaisesRegex(ValueError,'Source digest mismatch'): f.source(SHA)

    def test_overlay_is_explicit_readonly_directory_mount_and_off_base_has_no_selector(self):
        base=(ROOT/'compose.gcp.yaml').read_text(); overlay=(ROOT/'deploy/gcp/compose.mcp.yaml').read_text()
        self.assertNotIn('MCP_V2_PRODUCTION_PROFILE:',base)
        self.assertNotIn('/run/mcp-codec',base)
        self.assertIn('MCP_V2_PRODUCTION_PROFILE: seller-operations-v1',overlay)
        self.assertEqual(2,overlay.count('create_host_path: false'))
        self.assertEqual(2,overlay.count('read_only: true'))
        self.assertIn('target: /run/mcp-control\n',overlay)
        for path in ('src/mcp/deployment-profile.js','src/mcp/media-codec-client.js','media-codec/src/main.js','src/server.js'):
            self.assertTrue(path.startswith(u.PROTECTED))

if __name__=='__main__':unittest.main()
