/* Natural Earth shaded relief is projected onto the visible hemisphere. Regional and
   globe views use the same sphere and observation coordinates. */
(() => {
  'use strict';
  const DEG = Math.PI / 180;
  const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
  const wrap = lon => ((lon + 540) % 360 + 360) % 360 - 180;
  const regionalCenters = {
    'dogger-bank': {lon: 2.4, lat: 55, span: 20},
    'phoenix': {lon: -172.5, lat: -3.6, span: 25}
  };
  // Label anchors are cartographic context. Case positions always come from the record.
  const atlasLabels = [
    ['NORTH PACIFIC',-149,22,'ocean'],['SOUTH PACIFIC',-128,-29,'ocean'],
    ['CANADA',-106,56],['UNITED STATES',-99,39],['MEXICO',-101,24],
    ['COLOMBIA',-73,5],['PERU',-74,-10],['BRAZIL',-51,-12],['CHILE',-70,-25],
    ['GREENLAND',-43,73],['ATLANTIC OCEAN',-42,28,'ocean'],
    ['NORTH SEA',2,58,'ocean'],['NORWAY',9,65],['FRANCE',2,47],['SPAIN',-4,40],
    ['AUSTRALIA',134,-24],['JAPAN',138,38],['NEW ZEALAND',171,-43],
    ['INDIAN OCEAN',75,-17,'ocean'],['SOUTH AFRICA',25,-30]
  ];
  const textures = Object.create(null);
  const instances = new WeakMap();

  function texture(name) {
    if (textures[name]) return textures[name];
    const image = new Image();
    textures[name] = new Promise(resolve => {
      image.onload = () => {
        try {
          const buffer = document.createElement('canvas');
          buffer.width = image.naturalWidth;
          buffer.height = image.naturalHeight;
          const ctx = buffer.getContext('2d', {willReadFrequently: true});
          ctx.drawImage(image, 0, 0);
          resolve({data: ctx.getImageData(0, 0, buffer.width, buffer.height).data,
            width: buffer.width, height: buffer.height});
        } catch { resolve(null); }
      };
      image.onerror = () => resolve(null);
      image.src = '/map-assets/' + name + '-relief.webp';
    });
    return textures[name];
  }
  function validLocation(point) {
    return point && Number.isFinite(point.lat) && Number.isFinite(point.lon) &&
      Math.abs(point.lat) <= 90 && Math.abs(point.lon) <= 180;
  }
  function validBounds(map) {
    const b = map?.bounds;
    return Array.isArray(b) && b.length === 4 && b.every(Number.isFinite) &&
      b[0] >= -180 && b[2] <= 180 && b[0] < b[2] && b[1] >= -90 && b[3] <= 90 && b[1] < b[3];
  }
  function areaAnchor(area) {
    if (validLocation(area?.center)) return area.center;
    return Object.hasOwn(regionalCenters, area?.id) ? regionalCenters[area.id] : null;
  }
  function markerColors(point) {
    if (point.role === 'gap-start' || (!point.role && point.label === 'Last signal')) {
      return ['#ffbb6e', 'rgba(255,186,109,.45)'];
    }
    if (point.role === 'gap-end' || (!point.role && point.label === 'Signal resumed')) {
      return ['#a0f5e7', 'rgba(145,239,224,.45)'];
    }
    return ['#abcde5', 'rgba(171,205,229,.45)'];
  }
  function fit(data, width, height) {
    const points = [...data.points];
    if (validBounds(data.map)) {
      const [w,s,e,n] = data.map.bounds;
      points.push({lon:w,lat:s}, {lon:e,lat:n});
    }
    if (!points.length) {
      const anchor = areaAnchor(data.area);
      return anchor ? {lon:anchor.lon,lat:anchor.lat,span:anchor.span||25} : {lon:0,lat:15,span:140};
    }
    const reference = points[0].lon;
    const lons = points.map(p => reference + wrap(p.lon-reference));
    const lats = points.map(p => p.lat);
    const west = Math.min(...lons), east = Math.max(...lons);
    const south = Math.min(...lats), north = Math.max(...lats);
    const lat = (south + north) / 2, aspect = width / Math.max(1,height);
    const span = Math.max(12, (east-west)*Math.cos(lat*DEG)*1.65, (north-south)*aspect*1.6);
    return {lon:wrap((west+east)/2),lat,span:clamp(span,8,155)};
  }
  function camera(view,w,h,mini=false) {
    const globe = view.mode === 'globe';
    const tilt = globe ? 0 : Math.min(24, Math.max(0, 80 - Math.abs(view.lat)));
    const origin = clamp(view.lat - tilt, -89.95,89.95)*DEG;
    const desktop = w>=760 && !mini;
    const regionWidth = desktop ? Math.max(w*.54,w-500) : w*.95;
    const radius = globe ? (mini ? w*.435 :
      desktop ? Math.min(w*.35,h*.435) : Math.min(w*.49,h*.32))*view.mag :
      regionWidth/(2*Math.sin(clamp(view.span/2,.45,79)*DEG));
    const sin = Math.sin(origin), cos = Math.cos(origin);
    const cx = w*(mini?.5:desktop?.655:.5);
    const cy = h*(mini?.505:desktop?.435:.58) + radius*Math.sin(tilt*DEG);
    function project(lon,lat) {
      const dlon = wrap(lon-view.lon)*DEG;
      const phi = lat*DEG, cphi = Math.cos(phi), sphi = Math.sin(phi);
      const z = sin*sphi + cos*cphi*Math.cos(dlon);
      return {x:cx+radius*cphi*Math.sin(dlon),y:cy-radius*(cos*sphi-sin*cphi*Math.cos(dlon)),z};
    }
    return {radius,cx,cy,sin,cos,w,h,project,lon:view.lon};
  }
  function coord(n,latitude=false,decimals=2) {
    return Math.abs(n).toFixed(decimals) + '°' + (latitude ? (n<0?'S':'N') : (n<0?'W':'E'));
  }
  function screenTexture(canvas,cam,world,pacific,dragging) {
    const ratio = cam.w<=80?1:Math.min(window.devicePixelRatio||1, (dragging ? 520 : 1400)/cam.w);
    const width = Math.max(1,Math.round(cam.w*ratio)), height = Math.max(1,Math.round(cam.h*ratio));
    if(canvas.width !== width || canvas.height !== height) { canvas.width=width;canvas.height=height; }
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const output = ctx.createImageData(width,height);
    const pixels = output.data;
    const sx = cam.w/width/cam.radius, sy = cam.h/height/cam.radius;
    for(let y=0; y<height;y++) {
      const py = cam.cy/cam.radius-(y+.5)*sy;
      const yy = 1-py*py;
      for(let x=0; x<width;x++) {
        const px = (x+.5)*sx-cam.cx/cam.radius, zz=yy-px*px;
        if(zz<0) continue;
        const z=Math.sqrt(zz), i=(y*width+x)*4;
        const shade=.72+.28*z-.14*px+.10*py;
        let r=17, g=43, b=60;
        if(world) {
          const lat = Math.asin(clamp(py*cam.cos+z*cam.sin,-1,1))/DEG;
          const lon = wrap(cam.lon+Math.atan2(px,z*cam.cos-py*cam.sin)/DEG);
          const local = pacific && lon>=-146 && lon< -83 && lat>2 && lat<=38;
          const tex = local?pacific:world;
          const tx = local?(lon+146)/63*tex.width:(lon+180)/360*tex.width;
          const ty = local?(38-lat)/36*tex.height:(90-lat)/180*tex.height;
          const fx=clamp(tx-.5,0,tex.width-1), fy=clamp(ty-.5,0,tex.height-1);
          const x0=Math.floor(fx), y0=Math.floor(fy), dx=fx-x0, dy=fy-y0;
          const a=(y0*tex.width+x0)*4, b1=a+(x0+1<tex.width?4:0);
          const c=a+(y0+1<tex.height?tex.width*4:0), d=c+b1-a;
          const wa=(1-dx)*(1-dy), wb=dx*(1-dy), wc=(1-dx)*dy, wd=dx*dy, t=tex.data;
          r=t[a]*wa+t[b1]*wb+t[c]*wc+t[d]*wd;
          g=t[a+1]*wa+t[b1+1]*wb+t[c+1]*wc+t[d+1]*wd;
          b=t[a+2]*wa+t[b1+2]*wb+t[c+2]*wc+t[d+2]*wd;
        }
        const limb=Math.pow(1-z,6);
        pixels[i]=r*shade+limb*30;
        pixels[i+1]=g*shade+limb*50;
        pixels[i+2]=b*shade+limb*58;
        pixels[i+3]=255;
      }
    }
    ctx.putImageData(output,0,0);
  }
  function geoLine(ctx,cam,coords,stroke,width=1,dash=[]) {
    ctx.beginPath();
    let visible=false;
    for(const [lon,lat] of coords) {
      const p=cam.project(lon,lat);
      if(p.z>0) {
        if(visible) ctx.lineTo(p.x,p.y);
        else ctx.moveTo(p.x,p.y);
      }
      visible=p.z>0;
    }
    ctx.strokeStyle=stroke;ctx.lineWidth=width;ctx.setLineDash(dash);ctx.stroke();ctx.setLineDash([]);
  }
  function grid(ctx,cam,view) {
    const step=view.mode==='globe' ? 20 : view.span>35?10:view.span>15?5:view.span>4?2:1;
    const color=view.mode==='globe'?'rgba(155,191,189,.12)':'rgba(156,194,194,.21)';
    for(let lon=-180;lon<180;lon+=step) {
      const line=[];
      for(let lat=-90;lat<=90;lat+=2)line.push([lon,lat]);
      geoLine(ctx,cam,line,color,.65);
    }
    for(let lat=-80;lat<=80;lat+=step) {
      const line=[];
      for(let lon=-180;lon<=180;lon+=2)line.push([lon,lat]);
      geoLine(ctx,cam,line,color,.65);
    }
  }
  function perimeter(ctx,cam,map) {
    if(!validBounds(map)) return;
    const [w,s,e,n]=map.bounds;
    const corners=[[w,s],[e,s],[e,n],[w,n],[w,s]], ring=[];
    for(let side=0;side<4;side++) {
      const a=corners[side],b=corners[side+1];
      for(let j=0;j<18;j++) ring.push([a[0]+(b[0]-a[0])*j/18,a[1]+(b[1]-a[1])*j/18]);
    }
    ring.push(corners[0]);
    const projected=ring.map(([lon,lat])=>cam.project(lon,lat));
    if(projected.every(p=>p.z>0)) {
      ctx.beginPath(); projected.forEach((p,i)=>i?ctx.lineTo(p.x,p.y):ctx.moveTo(p.x,p.y));
      ctx.closePath();ctx.fillStyle='rgba(76,218,203,.095)';ctx.fill();
    }
    geoLine(ctx,cam,ring,'rgba(97,230,209,.92)',1.4,[5,4]);
  }
  function el(tag,cls,text) {
    const node=document.createElement(tag); if(cls)node.className=cls; if(text)node.textContent=text; return node;
  }
  function button(label,content,click) {
    const btn=el('button','mar-button',content);btn.type='button';btn.title=label;
    btn.setAttribute('aria-label',label);btn.addEventListener('click',click);return btn;
  }
  function create(container) {
    const root=el('div','mar-view'), terrain=el('canvas','mar-raster'), overlay=el('canvas','mar-overlay');
    const stage=el('div','mar-stage');
    stage.tabIndex=0;stage.setAttribute('aria-label','Interactive 3D map. Drag or use arrow keys to orbit, plus and minus to zoom, Home to fit the area.');
    terrain.setAttribute('aria-hidden','true');overlay.setAttribute('aria-hidden','true');
    stage.append(terrain,overlay);
    const modes=el('div','mar-modes'), tools=el('div','mar-tools');
    modes.setAttribute('role','group');modes.setAttribute('aria-label','Map view');
    tools.setAttribute('role','group');tools.setAttribute('aria-label','Map controls');
    const readout=el('div','mar-readout'), attribution=el('a','mar-attribution','Natural Earth ↗');
    attribution.href='https://www.naturalearthdata.com/downloads/50m-raster-data/50m-gray-earth/';
    attribution.target='_blank';attribution.rel='noopener noreferrer';
    const scale=el('span','mar-scale'), location=el('span','mar-location'), sr=el('span','mar-sr');
    const regionCallout=button('Inspect the selected protected area','',()=>reset('area'));
    regionCallout.classList.add('mar-callout');
    const calloutType=el('span','mar-callout-type','Protected area');
    const calloutName=el('span','mar-callout-name');
    regionCallout.append(calloutType,calloutName);
    const locator=button('Open globe at this map location','',()=>{
      view={...view,mode:'globe',mag:1};dirty();
    });
    locator.classList.add('mar-locator');
    const locatorCanvas=el('canvas','mar-locator-raster');
    locatorCanvas.setAttribute('aria-hidden','true');locator.append(locatorCanvas);
    const textureState=el('div','mar-texture-state');
    readout.append(scale,location);root.append(stage,regionCallout,modes,tools,locator,readout,attribution,sr,textureState);container.replaceChildren(root);

    let data={points:[]}, view={mode:'globe',lon:-108,lat:20,span:25,mag:1};
    let frame=0,drag=null,width=1,height=1,world=null,pacific=null,signature='',didFit=false;
    function reset(mode='area') {
      const home=fit(data,width,height);
      view={mode,lon:home.lon,lat:home.lat,span:home.span,mag:1};
      if(mode==='globe'){
        // Frame the park beside the North American coastline on the opening hemisphere.
        if(data.area?.id==='revillagigedo'){view.lon=-111;view.lat=20;}
        else {view.lon=wrap(home.lon+6);view.lat=clamp(home.lat+6,-80,80);}
      }
      didFit=true; dirty();
    }
    function zoom(direction) {
      if(view.mode==='globe') view.mag=clamp(view.mag*Math.pow(1.35,direction),.65,4);
      else view.span=clamp(view.span*Math.pow(.72,direction),1.3,150);
      dirty();
    }
    const areaBtn=button('Fit map to the selected area','Area',()=>reset('area'));
    const globeBtn=button('Show the 3D globe','Globe',()=>reset('globe'));
    modes.append(globeBtn,areaBtn);
    tools.append(button('Zoom in','+',()=>zoom(1)),button('Zoom out','−',()=>zoom(-1)),button('Reset map view','⌖',()=>reset(view.mode)));
    function dirty(){if(!frame)frame=requestAnimationFrame(paint);}
    function paint() {
      frame=0;
      if(width<2||height<2)return;
      const cam=camera(view,width,height);
      root.dataset.mode=view.mode;
      screenTexture(terrain,cam,world,pacific,Boolean(drag));
      const dpr=Math.min(devicePixelRatio||1,2);
      const cw=Math.round(width*dpr),ch=Math.round(height*dpr);
      if(overlay.width!==cw||overlay.height!==ch){overlay.width=cw;overlay.height=ch;}
      const ctx=overlay.getContext('2d'); if(!ctx)return;
      ctx.setTransform(dpr,0,0,dpr,0,0);ctx.clearRect(0,0,width,height);
      grid(ctx,cam,view);perimeter(ctx,cam,data.map);
      drawLabels(ctx,cam);
      locator.hidden=view.mode==='globe'||width<410||height<265;
      if(!locator.hidden){
        const side=80;
        const small=camera({...view,mode:'globe',mag:1.12},side,side,true);
        screenTexture(locatorCanvas,small,world,null,false);
        const lc=locatorCanvas.getContext('2d');
        if(lc){
          const p=small.project(view.lon,view.lat);
          lc.beginPath();lc.arc(p.x,p.y,3.8,0,2*Math.PI);lc.strokeStyle='#a7eee5';lc.lineWidth=1.15;lc.stroke();
          lc.fillStyle='#a7eee5';lc.fillRect(p.x-1,p.y-1,2,2);
        }
      }
      if(view.mode==='globe' && cam.radius<Math.max(width,height)*2){
        ctx.save();
        ctx.beginPath();ctx.arc(cam.cx,cam.cy,cam.radius,0,2*Math.PI);
        ctx.strokeStyle='rgba(118,182,188,.52)';ctx.lineWidth=1.15;
        ctx.shadowColor='rgba(94,176,190,.45)';ctx.shadowBlur=9;ctx.stroke();
        ctx.restore();
      }
      for(const [btn,mode] of [[areaBtn,'area'],[globeBtn,'globe']])btn.setAttribute('aria-pressed',String(view.mode===mode));
      const kmPerPx=6371/cam.radius;
      const rough=75*kmPerPx;
      const power=10**Math.floor(Math.log10(rough));
      const nice=(rough/power<2?1:rough/power<5?2:5)*power;
      scale.style.width=(nice/kmPerPx)+'px';
      scale.textContent=nice>=1?nice+' km':Math.round(nice*1000)+' m';
      location.textContent=coord(view.lat,true)+'  '+coord(view.lon);
    }
    function drawLabels(ctx,cam) {
      const occupied=[], padding=6;
      const inside=(p)=>p.z>0&&p.x>=3&&p.x<=width-3&&p.y>=3&&p.y<=height-3;
      const collides=(r)=>occupied.some(o=>r.x<o.x+o.w&&r.x+r.w>o.x&&r.y<o.y+o.h&&r.y+r.h>o.y);
      const areaCenter=validBounds(data.map)
        ? {lon:(data.map.bounds[0]+data.map.bounds[2])/2,lat:(data.map.bounds[1]+data.map.bounds[3])/2}
        : areaAnchor(data.area);
      const markers=data.points.map(point=>({p:cam.project(point.lon,point.lat),point})).filter(({p})=>inside(p));
      const observation=areaCenter ? null : markers.find(({p})=>p.z>.25);
      const target=areaCenter ? cam.project(areaCenter.lon,areaCenter.lat) : observation?.p;
      const showCallout=Boolean(view.mode==='globe'&&target&&target.z>.25&&inside(target)&&(observation||data.area?.name));
      regionCallout.hidden=!showCallout;
      if(showCallout){
        calloutType.textContent=observation?'Vessel observation':'Protected area';
        calloutName.textContent=observation ? observation.point.label||'Recorded position' : data.area.name;
        const action=observation?'Focus on recorded positions':'Inspect the selected protected area';
        regionCallout.title=action;regionCallout.setAttribute('aria-label',action);
        const labelWidth=regionCallout.offsetWidth;
        const placeRight=target.x+64+labelWidth<width-18;
        const px=clamp(placeRight?target.x+49:target.x-49-labelWidth,5,width-labelWidth-5);
        const py=clamp(target.y+24,52,height-80);
        regionCallout.style.left=px+'px';regionCallout.style.top=py+'px';
        occupied.push({x:px-2,y:py-2,w:labelWidth+4,h:regionCallout.offsetHeight+4});
        const edge=placeRight?px:px+labelWidth;
        ctx.beginPath();ctx.moveTo(target.x,target.y);
        ctx.lineTo(target.x+(placeRight?18:-18),py+12);ctx.lineTo(edge,py+12);
        ctx.strokeStyle='rgba(226,230,190,.72)';ctx.lineWidth=.85;ctx.stroke();
        ctx.beginPath();ctx.arc(target.x,target.y,11,0,Math.PI*2);
        ctx.lineWidth=1;ctx.strokeStyle='rgba(240,221,168,.82)';ctx.stroke();
        ctx.beginPath();ctx.arc(target.x,target.y,16,0,Math.PI*2);
        ctx.strokeStyle='rgba(240,221,168,.2)';ctx.stroke();
      }
      function label(p,text,color,options={}) {
        ctx.font=options.font||'600 10px "Segoe UI",sans-serif';
        const size=ctx.measureText(text).width+padding*2, h=20;
        for(const [dx,dy] of [[12,-22],[12,5],[-size-11,-22],[-size-11,5],[12,-39],[-size-11,-39]]) {
          const box={x:p.x+dx,y:p.y+dy,w:size,h};
          if(box.x<3||box.x+box.w>width-6||box.y<39||box.y+box.h>height-23||collides(box))continue;
          occupied.push(box);
          if(options.back){ctx.fillStyle='rgba(8,20,30,.9)';ctx.fillRect(box.x,box.y,size,h);
            ctx.strokeStyle='rgba(153,194,204,.28)';ctx.lineWidth=.7;ctx.strokeRect(box.x,box.y,size,h);}
          ctx.textBaseline='middle';ctx.fillStyle=color;
          ctx.shadowColor='rgba(4,13,18,.8)';ctx.shadowBlur=3;
          ctx.fillText(text,box.x+padding,box.y+h/2);ctx.shadowBlur=0;return;
        }
      }
      const compact=view.mode==='globe' || view.span>35;
      for(const {p} of markers) occupied.push({x:p.x-7,y:p.y-7,w:14,h:14});
      for(const {p,point} of markers) {
        const [tone,ring]=markerColors(point);
        ctx.beginPath();ctx.arc(p.x,p.y,10,0,2*Math.PI);ctx.strokeStyle=ring;ctx.lineWidth=1;ctx.stroke();
        ctx.beginPath();ctx.arc(p.x,p.y,5,0,2*Math.PI);ctx.fillStyle=tone;ctx.fill();ctx.lineWidth=1.5;ctx.strokeStyle='#13252d';ctx.stroke();
        if((!compact||markers.length===1)&&!(showCallout&&observation?.point===point))
          label(p,point.label||'Observed position',tone,{back:true});
      }
      if(!compact) {
        for(const island of data.map?.islands||[]) {
          if(!validLocation(island))continue;
          const p=cam.project(island.lon,island.lat);if(!inside(p))continue;
          ctx.beginPath();ctx.arc(p.x,p.y,2,0,2*Math.PI);ctx.fillStyle='#e6efde';ctx.fill();
          label(p,island.name,'#d0e0dd',{font:'10px "Segoe UI",sans-serif'});
        }
      }
      if(!showCallout&&(compact || !validBounds(data.map))&&data.area?.name) {
        if(areaCenter){const p=cam.project(areaCenter.lon,areaCenter.lat);if(inside(p)){
          ctx.strokeStyle='#8fc3d3';ctx.lineWidth=1;ctx.strokeRect(p.x-3,p.y-3,6,6);
          label(p,data.area.name,'#e2f3f4',{back:true});
        }}
      }
      if(view.mode==='globe'){
        for(const [text,lon,lat,kind] of atlasLabels){
          const p=cam.project(lon,lat);
          if(p.z<.31||!inside(p))continue;
          ctx.font=kind==='ocean'?'italic 12px Georgia,serif':'500 9px "Segoe UI",sans-serif';
          const w=ctx.measureText(text).width, box={x:p.x-w/2-4,y:p.y-7,w:w+8,h:14};
          if(collides(box)||box.x<5||box.x+box.w>width-5||box.y<40||box.y>height-25)continue;
          occupied.push(box);
          ctx.save();ctx.textAlign='center';ctx.textBaseline='middle';
          ctx.shadowColor='#0a1216';ctx.shadowBlur=3;
          ctx.fillStyle=kind==='ocean'?'#87a3ac':'#c2c9c1';ctx.fillText(text,p.x,p.y);
          ctx.restore();
        }
      }
    }
    function update(next) {
      const points=(next.points||[]).filter(validLocation);
      const key=JSON.stringify([next.area?.id,next.area?.center,next.caseId,next.map?.bounds,points]);
      data={...next,points};
      sr.textContent=(next.area?.name||'World')+'. '+(points.length?points.map(p=>(p.label||'Observed position')+' '+coord(p.lat,true)+', '+coord(p.lon)).join('. '):'No observed vessel positions.')+
        (validBounds(data.map)?' Verified perimeter displayed.':' Verified perimeter unavailable.');
      if(!signature){signature=key;reset(next.focusArea?'area':'globe');}
      else if(next.focusArea){signature=key;reset('area');}
      else if(key!==signature){signature=key;reset(view.mode);}
      else dirty();
    }
    function resize() {
      const priorWidth=width, priorHeight=height;
      width=root.clientWidth;height=root.clientHeight;
      if((priorWidth<2||priorHeight<2)&&width>1&&height>1)reset(view.mode);
      else dirty();
    }
    stage.addEventListener('pointerdown',e=>{
      if(e.button!==0||drag)return;
      stage.focus({preventScroll:true});stage.setPointerCapture(e.pointerId);drag={id:e.pointerId,x:e.clientX,y:e.clientY};stage.classList.add('mar-dragging');
    });
    stage.addEventListener('pointermove',e=>{
      if(!drag||drag.id!==e.pointerId)return;
      const cam=camera(view,width,height),unit=1/(cam.radius*DEG);
      view.lon=wrap(view.lon-(e.clientX-drag.x)*unit/Math.max(.22,Math.cos(view.lat*DEG)));
      view.lat=clamp(view.lat+(e.clientY-drag.y)*unit,-86,86);
      drag.x=e.clientX;drag.y=e.clientY;dirty();
    });
    function release(e){if(drag?.id!==e.pointerId)return;drag=null;stage.classList.remove('mar-dragging');dirty();}
    stage.addEventListener('pointerup',release);stage.addEventListener('lostpointercapture',release);
    stage.addEventListener('keydown',e=>{
      const movement=view.mode==='globe'?10/view.mag:view.span/12;
      if(e.key==='ArrowLeft')view.lon=wrap(view.lon-movement);
      else if(e.key==='ArrowRight')view.lon=wrap(view.lon+movement);
      else if(e.key==='ArrowUp')view.lat=clamp(view.lat+movement,-86,86);
      else if(e.key==='ArrowDown')view.lat=clamp(view.lat-movement,-86,86);
      else if(e.key==='+'||e.key==='=')zoom(1);
      else if(e.key==='-')zoom(-1);
      else if(e.key==='Home')reset(view.mode);
      else return;
      e.preventDefault();dirty();
    });
    stage.addEventListener('wheel',e=>{if(document.activeElement!==stage)return;e.preventDefault();zoom(e.deltaY<0?1:-1);},{passive:false});
    new ResizeObserver(resize).observe(root);resize();
    texture('earth').then(t=>{world=t;if(!t)textureState.textContent='Relief layer unavailable';dirty();});
    texture('pacific').then(t=>{pacific=t;dirty();});
    return {update,focusArea:()=>reset('area')};
  }
  window.SoundingsMap={render(container,data){
    let map=instances.get(container);
    if(!map||!container.querySelector('.mar-view')) {map=create(container);instances.set(container,map);}
    map.update(data);
  },focusArea(container){instances.get(container)?.focusArea();}};
})();
