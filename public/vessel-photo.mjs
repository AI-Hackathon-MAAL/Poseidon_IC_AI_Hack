function publicHttps(value) {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    if (url.protocol !== 'https:' || url.username || url.password || url.port ||
        !/\.[a-z]{2,}$/.test(host) || /\.(?:localhost|local|lan|internal)$/.test(host)) return null;
    return url.href;
  } catch { return null; }
}

const text = value => typeof value === 'string' ? value.trim() : '';
function imoNumber(value) {
  return /^(?:IMO\s*)?(\d{7})$/i.exec(String(value ?? '').trim())?.[1];
}

export function vesselPhoto(record) {
  const row = record?.snapshotCase || record;
  const photo = row?.vessel_photo;
  if (!photo || photo.display_permitted === false) return null;
  const license = text(photo.license);
  const openLicense = /^(?:CC0(?:[ -]1\.0)?|public domain|CC[ -]BY(?:[ -](?:NC|ND|SA))*(?:[ -][1-4]\.0)?)$/i.test(license);
  if (!openLicense && photo.display_permitted !== true) return null;
  const identityTypes = row.evidence?.resolve_identity?.ship_types;
  const types = [row.vessel_type, ...(Array.isArray(identityTypes) ? identityTypes : [])];
  if (types.some(type => text(type).toLowerCase() === 'gear')) return null;
  const caseId = text(row.vessel_id), photoId = text(photo.vessel_id);
  const caseImo = imoNumber(row.imo), photoImo = imoNumber(photo.imo);
  if (caseId && photoId && caseId !== photoId) return null;
  if (caseImo && photo.imo != null && caseImo !== photoImo) return null;
  if (!(caseId && photoId === caseId) && !(caseImo && photoImo === caseImo)) return null;
  const imageUrl = publicHttps(photo.image_url), sourceUrl = publicHttps(photo.source_url);
  const credit = text(photo.credit);
  if (!imageUrl || !sourceUrl || !credit || !license) return null;
  return {imageUrl, sourceUrl, credit, license, name:text(row.vessel_name) || 'Vessel'};
}

/** The figure is visible only after this case's identified photograph loads. */
export function renderVesselPhoto(container, record) {
  if (!container) return;
  container.hidden = true;
  container.replaceChildren();
  const photo = vesselPhoto(record);
  if (!photo) return;
  const doc = container.ownerDocument;
  const img = doc.createElement('img');
  img.alt = 'Photograph of ' + photo.name;
  img.referrerPolicy = 'no-referrer';
  img.decoding = 'async';
  const caption = doc.createElement('figcaption');
  const credit = doc.createElement('a');
  credit.href = photo.sourceUrl;
  credit.target = '_blank';
  credit.rel = 'noopener noreferrer';
  credit.textContent = photo.credit;
  caption.append(credit, ' · ' + photo.license);
  img.onload = () => { if (container.firstElementChild === img) container.hidden = false; };
  img.onerror = () => {
    if (container.firstElementChild === img) { container.hidden = true; container.replaceChildren(); }
  };
  container.append(img, caption);
  img.src = photo.imageUrl;
}
