/* Published geography on the same orthographic projection as the relief. */
(() => {
  'use strict';
  const ns = 'http://www.w3.org/2000/svg';
  const colors = {high:'#f3837f', medium:'#e4b468', low:'#77c5a3', unknown:'#93a5aa'};
  const wrap = lon => ((lon + 540) % 360 + 360) % 360 - 180;
  const locationOK = (lon,lat) => Number.isFinite(lon) && Math.abs(lon) <= 180 &&
    Number.isFinite(lat) && Math.abs(lat) <= 90;
  const svg = name => document.createElementNS(ns,name);
  const risk = region => region.n_high > 0 ? 'high' : region.n_medium > 0 ? 'medium' : region.n_low > 0 ? 'low' : 'unknown';
  const regionId = row => String(row.mpa_id);
  const coordText = point => point.x.toFixed(1) + ',' + point.y.toFixed(1);

  function regionBounds(region) {
    const b = region?.bbox;
    if (!Array.isArray(b) || b.length !== 4 || !locationOK(b[0],b[1]) ||
        !locationOK(b[2],b[3]) || b[0] === b[2] || b[1] >= b[3]) return null;
    const [west,south,east,north] = b;
    const degrees = east >= west ? east - west : 360 + east - west;
    return {lon:wrap(west + degrees/2),lat:(south + north)/2,degrees,elevation:north - south};
  }
  function center(region) {
    if (locationOK(region?.center_lon,region?.center_lat)) return {lon:region.center_lon,lat:region.center_lat};
    return null;
  }
  function frame(region,width,height) {
    const bounds = regionBounds(region);
    if (!bounds) {
      const anchor = center(region);
      return anchor ? {...anchor,span:12} : null;
    }
    const horizontal = bounds.degrees * Math.cos(bounds.lat * Math.PI/180) * 1.55;
    const availableWidth = width >= 760 ? Math.max(width*.54,width-500) : width*.95;
    const vertical = bounds.elevation * availableWidth / Math.max(1,height) * 1.9;
    return {lon:bounds.lon,lat:bounds.lat,span:Math.max(1.3,Math.min(155,Math.max(horizontal,vertical)))};
  }
  function interpolate(a,b) {
    const dLon = wrap(b[0]-a[0]), dLat = b[1]-a[1];
    const n = Math.max(1,Math.ceil(Math.max(Math.abs(dLon),Math.abs(dLat))/2));
    return Array.from({length:n},(_,i) => [wrap(a[0]+dLon*i/n),a[1]+dLat*i/n]);
  }
  function rings(region) {
    const shape = region.boundary;
    if (!shape || !Array.isArray(shape.coordinates)) return [];
    const polygons = shape.type === 'MultiPolygon' ? shape.coordinates : shape.type === 'Polygon' ? [shape.coordinates] : [];
    return polygons.flatMap(polygon => {
      if (!Array.isArray(polygon) || !polygon.length || !polygon.every(ring =>
        Array.isArray(ring) && ring.length >= 4 && ring.every(p => Array.isArray(p) && locationOK(p[0],p[1])))) return [];
      return [polygon.map(ring => ring.flatMap((a,i) => interpolate(a,ring[(i+1)%ring.length])))];
    });
  }
  // At the horizon draw only visible perimeter segments. Never join visible
  // fragments across the back of the Earth or fill a clipped fragment as land.
  function geometry(polygons,cam) {
    let fill = '', stroke = '';
    for (const polygon of polygons) {
      let outline = '', whollyVisible = true;
      for (const ring of polygon) {
        let penDown = false, complete = true, path = '';
        for (const [lon,lat] of ring) {
          const point = cam.project(lon,lat);
          if (point.z <= 0) { penDown=false; complete=false; continue; }
          path += (penDown ? 'L' : 'M') + coordText(point);
          penDown=true;
        }
        if (complete && path) path += 'Z';
        whollyVisible &&= complete;
        outline += path;
      }
      stroke += outline;
      if (whollyVisible) fill += outline;
    }
    return {fill,stroke};
  }
  function titleFor(item,domain) {
    return [item.title || 'Regional report',domain,item.place_type === 'country' ? 'country-level' : ''].filter(Boolean).join(' · ');
  }
  function article(item) {
    if (item.place_type === 'none' || !locationOK(item.lon,item.lat)) return null;
    try {
      const url = new URL(item.url);
      if (!['https:','http:'].includes(url.protocol) || url.username || url.password) return null;
      return {...item,url:url.href,label:titleFor(item,url.hostname.replace(/^www\./,''))};
    } catch { return null; }
  }
  const inView = (point,cam) => point.z > 0 && point.x >= 0 && point.y >= 0 && point.x <= cam.w && point.y <= cam.h;
  const overlap = (a,b) => a.x < b.x+b.w && a.x+a.w > b.x && a.y < b.y+b.h && a.y+a.h > b.y;
  function tagPosition(anchor,width,cam,occupied) {
    const slots=[[26,-30],[-width-26,-30],[26,15],[-width-26,15],[26,-60],[-width-26,46]];
    for (const [dx,dy] of slots) {
      const box={x:anchor.x+dx,y:anchor.y+dy,w:width,h:22};
      if (box.x<4 || box.y<5 || box.x+width>cam.w-4 || box.y+22>cam.h-5) continue;
      if (!occupied.some(obstacle=>overlap(box,obstacle))) return box;
    }
    return null;
  }
  function makeControl(label, activate) {
    const group = svg('g');
    group.setAttribute('role','button');group.setAttribute('tabindex','0');group.setAttribute('aria-label',label);
    const title = svg('title');title.textContent=label;group.append(title);
    group.addEventListener('click',activate);
    group.addEventListener('keydown',event => {
      if (event.key === 'Enter' || event.key === ' ') {event.preventDefault();event.stopPropagation();activate(event);}
    });
    return group;
  }
  function show(node,visible) {node.style.display=visible?'':'none';}
  function create(stage,onRegion,onArticles) {
    const overlay=svg('svg'), areas=svg('g'), intel=svg('g');
    overlay.classList.add('mar-geography');overlay.setAttribute('aria-label','Published protected areas and global news');
    overlay.append(areas,intel);stage.insertBefore(overlay,stage.querySelector('.mar-observations'));
    let mappedAreas=[], news=[], previousRegions,previousNews;
    const newsNodes=[];
    function setData(regions,globalNews) {
      if (regions !== previousRegions) {
        previousRegions=regions;areas.replaceChildren();
        mappedAreas=(regions||[]).filter(row=>row?.mpa_id!=null).flatMap(region=>{
          const polygons=rings(region), anchor=center(region), bounds=regionBounds(region);
          if (!polygons.length && !anchor) return [];
          const name=region.mpa_name || regionId(region), id=regionId(region);
          const group=makeControl('Explore '+name,() => onRegion(id));
          const fill=svg('path'),stroke=svg('path'),ring=svg('circle'),label=svg('text');
          fill.setAttribute('fill-rule','evenodd');ring.setAttribute('r','7');
          fill.classList.add('geo-fill');stroke.classList.add('geo-stroke');ring.classList.add('geo-ring');label.classList.add('geo-name');
          group.classList.add('geo-area');show(group,false);group.style.setProperty('--area-tone',colors[risk(region)]);
          const tag=svg('g'),leader=svg('line'),background=svg('rect'),tagName=svg('text');
          tag.classList.add('geo-tag');
          const shortName=name.replace(/\s*[-–]\s*Reserva Marina$/i,'').replace(/\s*\(synthetic\)$/i,'');
          tagName.textContent=shortName.length>29?shortName.slice(0,28)+'…':shortName;
          const tagWidth=tagName.textContent.length*6.6+19;
          background.setAttribute('width',tagWidth);background.setAttribute('height','22');background.setAttribute('rx','2');
          tag.append(leader,background,tagName);
          label.textContent=name;group.append(fill,stroke,ring,label,tag);areas.append(group);
          return [{id,polygons,anchor,labelAnchor:anchor||bounds,group,fill,stroke,ring,label,tag,leader,background,tagName,tagWidth}];
        });
      }
      if (globalNews !== previousNews) {
        previousNews=globalNews;news=(globalNews||[]).filter(Boolean).map(article).filter(Boolean);
      }
    }
    function draw(cam,view,activeRegion,detail,contacts=[]) {
      const areaMode=Boolean(activeRegion);
      const shipBoxes=areaMode || detail ? [] : (contacts||[]).map(point=>cam.project(point.lon,point.lat)).filter(p=>inView(p,cam))
        .map(p=>({x:p.x-20,y:p.y-20,w:40,h:40}));
      const occupied=shipBoxes.slice();
      for (const area of mappedAreas) {
        if (areaMode && area.id!==activeRegion) {show(area.group,false);continue;}
        const path=geometry(area.polygons,cam);
        const anchor=area.labelAnchor && cam.project(area.labelAnchor.lon,area.labelAnchor.lat);
        const ringHere=!area.polygons.length && area.anchor && anchor && inView(anchor,cam);
        show(area.group,Boolean(path.stroke || ringHere));
        area.fill.setAttribute('d',path.fill);area.stroke.setAttribute('d',path.stroke);
        show(area.ring,ringHere);
        if (ringHere) {area.ring.setAttribute('cx',anchor.x);area.ring.setAttribute('cy',anchor.y);}
        const nearShip=anchor && shipBoxes.some(b=>overlap(b,{x:anchor.x-11,y:anchor.y-11,w:22,h:22}));
        const placement=nearShip && inView(anchor,cam) && tagPosition(anchor,area.tagWidth,cam,occupied);
        show(area.tag,Boolean(placement));
        if(placement){
          occupied.push(placement);
          const {x,y,w,h}=placement;
          area.leader.setAttribute('x1',anchor.x);area.leader.setAttribute('y1',anchor.y);
          area.leader.setAttribute('x2',x>anchor.x?x:x+w);area.leader.setAttribute('y2',y+h/2);
          area.background.setAttribute('x',x);area.background.setAttribute('y',y);
          area.tagName.setAttribute('x',x+9);area.tagName.setAttribute('y',y+14);
        }
        const labelHere=anchor && !placement && inView(anchor,cam) && !detail && (view.mode==='area'||view.mag>1.5);
        show(area.label,labelHere);
        if (labelHere) {area.label.setAttribute('x',anchor.x+10);area.label.setAttribute('y',anchor.y-9);}
      }
      const groups=[];
      if (!areaMode && !detail) for (const item of news) {
        const p=cam.project(item.lon,item.lat);
        if (!inView(p,cam)) continue;
        const near=groups.find(other=>Math.hypot(other.x-p.x,other.y-p.y)<20);
        if (near) near.items.push(item);
        else groups.push({...p,items:[item]});
      }
      groups.forEach((group,i)=>{
        let node=newsNodes[i];
        if (!node) {
          node=makeControl('Global news',()=>onArticles(node.newsGroup,node));
          node.classList.add('geo-news');
          const hit=svg('circle'),diamond=svg('path');
          hit.setAttribute('r','9');hit.setAttribute('fill','transparent');
          diamond.setAttribute('d','M0 -5 L5 0 L0 5 L-5 0Z');
          node.append(hit,diamond);intel.append(node);newsNodes.push(node);
        }
        node.newsGroup=group;
        node.setAttribute('transform','translate('+coordText(group)+')');
        const title=group.items.map(item=>item.label).join('\n');
        node.firstElementChild.textContent=title;node.setAttribute('aria-label',title);
        node.classList.toggle('country-level',group.items.every(item=>item.place_type==='country'));
        node.classList.toggle('multiple',group.items.length>1);
      });
      while(newsNodes.length>groups.length) newsNodes.pop().remove();
    }
    return {setData,draw};
  }
  window.PoseidonGeoLayers={create,frame,center,colors,regionBounds};
})();
