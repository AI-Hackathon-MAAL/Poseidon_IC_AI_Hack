import test from 'node:test';
import assert from 'node:assert/strict';
import {vesselPhoto,renderVesselPhoto} from '../public/vessel-photo.mjs';

const photo = {vessel_id:'stable-id', image_url:'https://registry.example/photos/1', source_url:'https://registry.example/ships/1',
  credit:'Vessel registry', license:'CC BY 4.0', display_permitted:true};
const record = {vessel_id:'stable-id', imo:'IMO 1234567', vessel_name:'A Vessel', vessel_photo:photo};

test('uses an explicitly permitted photograph only when its stable identifiers agree', () => {
  assert.equal(vesselPhoto({snapshotCase:record}).credit,'Vessel registry');
  assert.ok(vesselPhoto({...record,vessel_photo:{...photo, vessel_id:undefined, imo:1234567}}));
  assert.ok(vesselPhoto({...record,vessel_photo:{...photo, display_permitted:undefined}}));
  for (const change of [{vessel_id:undefined, vessel_name:'A Vessel'}, {imo:'7654321'},
    {image_url:'https://u:token@registry.example/p'}, {image_url:'https://127.0.0.1/private'},
    {source_url:'javascript:void(0)'}, {license:''}, {display_permitted:false},
    {license:'All rights reserved',display_permitted:undefined}]) {
    assert.equal(vesselPhoto({...record,vessel_photo:{...photo,...change}}), null);
  }
  assert.equal(vesselPhoto({...record,vessel_type:'gear'}), null);
});

test('a late image load cannot reveal a previously selected case, or an unavailable image', () => {
  const container = {hidden:false, ownerDocument:{createElement:() => ({append(){}})},
    replaceChildren(){this.firstElementChild=null;}, append(el){this.firstElementChild=el;}};
  renderVesselPhoto(container, record);
  const first = container.firstElementChild;
  assert.equal(container.hidden,true);
  first.onload();
  assert.equal(container.hidden,false);
  renderVesselPhoto(container, null);
  first.onload();
  assert.equal(container.hidden,true);
  renderVesselPhoto(container,record);
  container.firstElementChild.onerror();
  assert.equal(container.firstElementChild,null);
});
