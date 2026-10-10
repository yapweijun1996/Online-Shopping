#!/usr/bin/env python3
"""Read-only owner check before the updater enters the multi-database maintenance window."""
import argparse
import json
from postgres_backup import OwnerPostgres, IDENTIFIER


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--container',required=True)
    parser.add_argument('--shop-version',type=int,required=True)
    parser.add_argument('--platform-version',type=int,required=True)
    args=parser.parse_args(); owner=OwnerPostgres('orbstack',args.container)
    required=False
    for database,version in [('online_shopping',args.shop_version),('platform',args.platform_version)]:
        if not owner.exists(database): raise RuntimeError('A configured database does not exist.')
        meta=owner.query(database,"SELECT to_regclass('public.schema_meta') IS NOT NULL;")=='t'
        previous=int(owner.query(database,'SELECT version FROM schema_meta WHERE id=1;')) if meta else 0
        if previous>version: raise RuntimeError('Schema downgrades are never automatic.')
        required |= previous<version
    if owner.query('platform',"SELECT to_regclass('public.tenant') IS NOT NULL;")=='t':
        rows=json.loads(owner.query('platform',"SELECT COALESCE(json_agg(database_name),'[]'::json) FROM tenant WHERE is_default=0 AND status IN ('ACTIVE','SUSPENDED','DELETING');"))
        for name in rows:
            if not isinstance(name,str) or not IDENTIFIER.fullmatch(name): raise RuntimeError('Unexpected database identifier.')
            previous=int(owner.query(name,'SELECT version FROM schema_meta WHERE id=1;'))
            if previous>args.shop_version: raise RuntimeError('Schema downgrades are never automatic.')
            required |= previous<args.shop_version
    print(json.dumps({'required':bool(required)}))


if __name__=='__main__':
    try:main()
    except Exception as error:
        print('Upgrade preflight failed:',type(error).__name__,file=__import__('sys').stderr)
        raise SystemExit(1)
