#!/usr/bin/env python3
"""Encode reviewed original images without changing their content; originals retained.
macOS: python3 scripts/demo-gallery-assets.py output/gallery-generated.json [--pilot]
The committed variants/manifests are verified in CI; generation needs no CI key.
"""
import hashlib,json,re,subprocess,sys
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
reviewed=json.loads(Path(sys.argv[1]).read_text());pilot='--pilot' in sys.argv
heroes=json.loads((ROOT/'src/public-demo-image-manifest.json').read_text())['assets']
source_root=ROOT.parent/'generated_images'
assets=[];products={};labels={1:'Hero view',2:'Alternate view',3:'Elevated view',4:'Surface detail',5:'Construction detail',6:'Context view'}
for hero in heroes:
 sku=hero['sku']; extras=sorted((x for x in reviewed.values() if x['sku']==sku and x.get('review','').startswith('approved')),key=lambda x:x['view'])
 if not extras:
  if pilot: continue
  raise SystemExit('Missing reviewed gallery: '+sku)
 if not 5<=len(extras)<=9: raise SystemExit('Gallery must have 6–10 useful images: '+sku)
 views=[{'sku':sku,'view':1,'path':str(source_root/hero['sourceFile']),'review':'approved original hero, unchanged','prompt':hero['brief']},*extras]
 media=[]
 for v in views:
  original=Path(v['path']);digest=hashlib.sha256(original.read_bytes()).hexdigest();dest=ROOT/'public/demo-assets'/sku;dest.mkdir(parents=True,exist_ok=True)
  variants=[]
  for width,quality,budget in [(160,70,24*1024),(640,76,160*1024),(1254,82,768*1024)]:
   file=dest/f"view-{v['view']}-{digest[:12]}-{width}.jpg"
   for q in range(quality, max(22,quality-43), -6):
    subprocess.run(['sips','-Z',str(width),'-s','format','jpeg','-s','formatOptions',str(q),str(original),'--out',str(file)],check=True,stdout=subprocess.DEVNULL)
    if file.stat().st_size<=budget:break
   if file.stat().st_size>budget:raise SystemExit('Asset budget exceeded: '+str(file))
   dimensions=subprocess.check_output(['sips','-g','pixelWidth','-g','pixelHeight',str(file)],text=True)
   actual_width=int(re.search(r'pixelWidth: (\d+)',dimensions)[1]);actual_height=int(re.search(r'pixelHeight: (\d+)',dimensions)[1])
   variants.append({'url':'/'+file.relative_to(ROOT/'public').as_posix(),'width':actual_width,'height':actual_height,'bytes':file.stat().st_size,'sha256':hashlib.sha256(file.read_bytes()).hexdigest(),'quality':q})
  thumb,display,full=variants
  label=v.get('caption') or labels.get(v['view'],'Additional view')
  media.append({'src':display['url'],'thumbnail':thumb['url'],'full':full['url'],'srcset':display['url']+f" {display['width']}w, "+full['url']+f" {full['width']}w",'width':full['width'],'height':full['height'],'alt':hero['name']+', '+label.lower()+'. Fictional AI-generated illustration.','caption':'Fictional illustration · '+label})
  assets.append({'sku':sku,'view':v['view'],'sourceFile':original.name,'sourceSha256':digest,'referenceHeroSha256':hero['sourceSha256'],'origin':'OpenAI built-in image generation','generatedDate':'2026-10-01','review':v['review'],'prompt':v.get('prompt','reference-preserving alternate view'),'variants':variants})
  if v.get('promptProvenance'): assets[-1]['promptProvenance']=v['promptProvenance']
 products[sku]={'name':hero['name'],'heroSha256':hero['assetSha256'],'media':media}
(ROOT/'src/public-demo-gallery.json').write_text(json.dumps({'products':products},indent=2)+'\n')
(ROOT/'src/public-demo-gallery-provenance.json').write_text(json.dumps({'notice':'Fictional reference-preserving AI illustrations; no exclusive copyright guarantee. Original heroes retained.','productCount':len(products),'imageCount':len(assets),'perProductCounts':{sku:len(v['media']) for sku,v in products.items()},'assets':assets},indent=2)+'\n')
print(json.dumps({'products':len(products),'images':len(assets),'totalBytes':sum(v['bytes'] for a in assets for v in a['variants'])}))
