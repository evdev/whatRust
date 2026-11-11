//! Copy the AAC track out of a WhatsApp video into an audio-only M4A.
//!
//! The video bytes stay in memory. FluidVoice only receives the M4A this
//! module builds, so the picture is never sent.

use crate::voice::MAX_AUDIO;

#[derive(Debug, PartialEq, Eq)]
pub enum ExtractError {
    NoAudio,
    BadAudio,
    TooLarge,
}

impl ExtractError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::NoAudio => "no_audio",
            Self::BadAudio => "bad_audio",
            Self::TooLarge => "too_large",
        }
    }
}

#[derive(Clone, Copy)]
struct Atom {
    typ: [u8; 4],
    start: usize,
    payload_start: usize,
    payload_end: usize,
    end: usize,
}

struct SampleRun {
    first_chunk: u32,
    samples_per_chunk: u32,
    description: u32,
}

struct AudioTrack {
    timescale: u32,
    duration: u64,
    sample_entry: Vec<u8>,
    sizes: Vec<u32>,
    chunks: Vec<u64>,
    runs: Vec<SampleRun>,
    stts: Option<Vec<u8>>,
}

/// AAC (`mp4a`) from a non-fragmented MP4 or 3GP, wrapped as an audio-only M4A.
pub fn aac_m4a(data: &[u8]) -> Result<Vec<u8>, ExtractError> {
    let top = top_atoms(data)?;
    if top.iter().any(|atom| &atom.typ == b"moof") {
        return Err(ExtractError::BadAudio);
    }
    let moov = top
        .iter()
        .find(|atom| &atom.typ == b"moov")
        .copied()
        .ok_or(ExtractError::BadAudio)?;
    if child(data, moov.payload_start, moov.payload_end, b"mvex")?.is_some() {
        return Err(ExtractError::BadAudio);
    }
    let track = audio_track(data, &moov)?;
    let samples = concat_samples(data, &track)?;
    build_m4a(&track, &samples)
}

fn audio_track(data: &[u8], moov: &Atom) -> Result<AudioTrack, ExtractError> {
    let mut saw_sound = false;
    for trak in children(data, moov.payload_start, moov.payload_end)? {
        if &trak.typ != b"trak" {
            continue;
        }
        let Some(mdia) = child(data, trak.payload_start, trak.payload_end, b"mdia")? else {
            continue;
        };
        let Some(hdlr) = child(data, mdia.payload_start, mdia.payload_end, b"hdlr")? else {
            continue;
        };
        if handler_type(data, &hdlr)? != *b"soun" {
            continue;
        }
        saw_sound = true;
        if let Some(track) = mp4a_track(data, &mdia)? {
            return Ok(track);
        }
    }
    if saw_sound {
        Err(ExtractError::BadAudio)
    } else {
        Err(ExtractError::NoAudio)
    }
}

fn mp4a_track(data: &[u8], mdia: &Atom) -> Result<Option<AudioTrack>, ExtractError> {
    let Some(minf) = child(data, mdia.payload_start, mdia.payload_end, b"minf")? else {
        return Ok(None);
    };
    let Some(stbl) = child(data, minf.payload_start, minf.payload_end, b"stbl")? else {
        return Ok(None);
    };
    let Some(stsd) = child(data, stbl.payload_start, stbl.payload_end, b"stsd")? else {
        return Ok(None);
    };
    let entries = stsd_entries(data, &stsd)?;
    let Some((index, entry)) = entries
        .iter()
        .enumerate()
        .find(|(_, atom)| &atom.typ == b"mp4a")
    else {
        return Ok(None);
    };
    let description = u32::try_from(index + 1).map_err(|_| ExtractError::BadAudio)?;
    let Some(mdhd) = child(data, mdia.payload_start, mdia.payload_end, b"mdhd")? else {
        return Err(ExtractError::BadAudio);
    };
    let (timescale, duration) = parse_mdhd(data, &mdhd)?;
    let sizes = parse_stsz(data, &required_child(data, &stbl, b"stsz")?)?;
    let chunks = parse_chunks(data, &stbl)?;
    let runs = parse_stsc(data, &required_child(data, &stbl, b"stsc")?)?;
    if runs.iter().any(|run| run.description != description) {
        return Err(ExtractError::BadAudio);
    }
    let stts = matching_stts(data, &stbl, sizes.len())?;
    Ok(Some(AudioTrack {
        timescale: if timescale == 0 { 44_100 } else { timescale },
        duration: if duration == 0 {
            sizes.len() as u64 * 1024
        } else {
            duration
        },
        sample_entry: prepared_sample_entry(&data[entry.start..entry.end]),
        sizes,
        chunks,
        runs,
        stts,
    }))
}

fn prepared_sample_entry(entry: &[u8]) -> Vec<u8> {
    let mut bytes = entry.to_vec();
    if bytes.len() < 8 {
        return bytes;
    }
    let size = u32::from_be_bytes(bytes[0..4].try_into().unwrap());
    // A box of size 0 means "until the end of the parent". Copied into the new
    // file, that would swallow the rest of the movie header.
    if size == 0 {
        if let Ok(size) = u32::try_from(bytes.len()) {
            bytes[0..4].copy_from_slice(&size.to_be_bytes());
        }
    }
    // The rebuilt file has one data reference, the samples in this M4A.
    let header = if size == 1 { 16 } else { 8 };
    let at = header + 6;
    if bytes.len() >= at + 2 {
        bytes[at] = 0;
        bytes[at + 1] = 1;
    }
    bytes
}

fn concat_samples(data: &[u8], track: &AudioTrack) -> Result<Vec<u8>, ExtractError> {
    if track.sizes.is_empty() || track.chunks.is_empty() || track.runs.is_empty() {
        return Err(ExtractError::BadAudio);
    }
    let mut out = Vec::new();
    let mut sample_index = 0usize;
    let last = track.chunks.len() - 1;
    for (chunk_index, offset) in track.chunks.iter().copied().enumerate() {
        let chunk_no = u32::try_from(chunk_index + 1).map_err(|_| ExtractError::BadAudio)?;
        let per_chunk = samples_in_chunk(&track.runs, chunk_no)?;
        let per_chunk = usize::try_from(per_chunk).map_err(|_| ExtractError::BadAudio)?;
        // ISO 14496-12: only the last chunk may contain fewer samples than
        // samples_per_chunk. WhatsApp files do that.
        let remaining = track.sizes.len() - sample_index;
        let take = if chunk_index == last {
            if remaining == 0 || remaining > per_chunk {
                return Err(ExtractError::BadAudio);
            }
            remaining
        } else if remaining < per_chunk {
            return Err(ExtractError::BadAudio);
        } else {
            per_chunk
        };
        let mut cursor = usize::try_from(offset).map_err(|_| ExtractError::BadAudio)?;
        for _ in 0..take {
            let size = track.sizes[sample_index] as usize;
            let end = cursor.checked_add(size).ok_or(ExtractError::BadAudio)?;
            let bytes = data.get(cursor..end).ok_or(ExtractError::BadAudio)?;
            if out.len().saturating_add(bytes.len()) > MAX_AUDIO {
                return Err(ExtractError::TooLarge);
            }
            out.extend_from_slice(bytes);
            cursor = end;
            sample_index += 1;
        }
    }
    if sample_index != track.sizes.len() {
        return Err(ExtractError::BadAudio);
    }
    Ok(out)
}

fn samples_in_chunk(runs: &[SampleRun], chunk_no: u32) -> Result<u32, ExtractError> {
    let mut chosen = None;
    for run in runs {
        if run.first_chunk <= chunk_no {
            chosen = Some(run);
        } else {
            break;
        }
    }
    let run = chosen.ok_or(ExtractError::BadAudio)?;
    if run.first_chunk == 0 || run.samples_per_chunk == 0 {
        return Err(ExtractError::BadAudio);
    }
    Ok(run.samples_per_chunk)
}

fn build_m4a(track: &AudioTrack, samples: &[u8]) -> Result<Vec<u8>, ExtractError> {
    let count = u32::try_from(track.sizes.len()).map_err(|_| ExtractError::BadAudio)?;
    let ftyp = iso_box(b"ftyp", &ftyp_payload())?;
    // The chunk offset depends on the moov size, and the moov size does not
    // depend on the offset's value, so a zero offset measures the final moov.
    let moov_len = build_moov(track, count, 0)?.len();
    let offset = u64::try_from(ftyp.len() + moov_len + 8).map_err(|_| ExtractError::BadAudio)?;
    if offset > u64::from(u32::MAX) {
        return Err(ExtractError::BadAudio);
    }
    let moov = build_moov(track, count, offset as u32)?;
    if moov.len() != moov_len {
        return Err(ExtractError::BadAudio);
    }
    let mdat = iso_box(b"mdat", samples)?;
    let mut out = Vec::with_capacity(ftyp.len() + moov.len() + mdat.len());
    out.extend(ftyp);
    out.extend(moov);
    out.extend(mdat);
    Ok(out)
}

fn ftyp_payload() -> Vec<u8> {
    let mut payload = Vec::new();
    payload.extend(b"M4A ");
    payload.extend(0u32.to_be_bytes());
    payload.extend(b"M4A ");
    payload.extend(b"mp42");
    payload.extend(b"isom");
    payload
}

fn build_moov(track: &AudioTrack, count: u32, chunk_offset: u32) -> Result<Vec<u8>, ExtractError> {
    let mut trak = Vec::new();
    trak.extend(tkhd(track.duration)?);
    trak.extend(mdia(track, count, chunk_offset)?);
    let trak = iso_box(b"trak", &trak)?;
    let mut moov = mvhd(track.timescale, track.duration)?;
    moov.extend(trak);
    iso_box(b"moov", &moov)
}

fn mvhd(timescale: u32, duration: u64) -> Result<Vec<u8>, ExtractError> {
    let mut payload = Vec::new();
    if duration <= u64::from(u32::MAX) {
        payload.extend(0u32.to_be_bytes());
        payload.extend(0u32.to_be_bytes());
        payload.extend(0u32.to_be_bytes());
        payload.extend(timescale.to_be_bytes());
        payload.extend((duration as u32).to_be_bytes());
    } else {
        payload.push(1);
        payload.extend([0, 0, 0]);
        payload.extend(0u64.to_be_bytes());
        payload.extend(0u64.to_be_bytes());
        payload.extend(timescale.to_be_bytes());
        payload.extend(duration.to_be_bytes());
    }
    payload.extend(0x00010000u32.to_be_bytes());
    payload.extend(0x0100u16.to_be_bytes());
    payload.extend(0u16.to_be_bytes());
    payload.extend([0u8; 8]);
    push_matrix(&mut payload);
    payload.extend([0u8; 24]);
    payload.extend(2u32.to_be_bytes());
    iso_box(b"mvhd", &payload)
}

fn tkhd(duration: u64) -> Result<Vec<u8>, ExtractError> {
    let mut payload = Vec::new();
    if duration <= u64::from(u32::MAX) {
        payload.extend(7u32.to_be_bytes());
        payload.extend(0u32.to_be_bytes());
        payload.extend(0u32.to_be_bytes());
        payload.extend(1u32.to_be_bytes());
        payload.extend(0u32.to_be_bytes());
        payload.extend((duration as u32).to_be_bytes());
    } else {
        payload.push(1);
        payload.extend([0, 0, 7]);
        payload.extend(0u64.to_be_bytes());
        payload.extend(0u64.to_be_bytes());
        payload.extend(1u32.to_be_bytes());
        payload.extend(0u32.to_be_bytes());
        payload.extend(duration.to_be_bytes());
    }
    payload.extend([0u8; 8]);
    payload.extend(0u16.to_be_bytes());
    payload.extend(0u16.to_be_bytes());
    payload.extend(0x0100u16.to_be_bytes());
    payload.extend(0u16.to_be_bytes());
    push_matrix(&mut payload);
    payload.extend(0u32.to_be_bytes());
    payload.extend(0u32.to_be_bytes());
    iso_box(b"tkhd", &payload)
}

fn mdia(track: &AudioTrack, count: u32, chunk_offset: u32) -> Result<Vec<u8>, ExtractError> {
    let mut payload = mdhd(track.timescale, track.duration)?;
    payload.extend(hdlr(b"soun", b"SoundHandler\0")?);
    payload.extend(minf(track, count, chunk_offset)?);
    iso_box(b"mdia", &payload)
}

fn mdhd(timescale: u32, duration: u64) -> Result<Vec<u8>, ExtractError> {
    let mut payload = Vec::new();
    if duration <= u64::from(u32::MAX) {
        payload.extend(0u32.to_be_bytes());
        payload.extend(0u32.to_be_bytes());
        payload.extend(0u32.to_be_bytes());
        payload.extend(timescale.to_be_bytes());
        payload.extend((duration as u32).to_be_bytes());
    } else {
        payload.push(1);
        payload.extend([0, 0, 0]);
        payload.extend(0u64.to_be_bytes());
        payload.extend(0u64.to_be_bytes());
        payload.extend(timescale.to_be_bytes());
        payload.extend(duration.to_be_bytes());
    }
    payload.extend(0x55C4u16.to_be_bytes());
    payload.extend(0u16.to_be_bytes());
    iso_box(b"mdhd", &payload)
}

fn hdlr(kind: &[u8; 4], name: &[u8]) -> Result<Vec<u8>, ExtractError> {
    let mut payload = Vec::new();
    payload.extend(0u32.to_be_bytes());
    payload.extend(0u32.to_be_bytes());
    payload.extend(kind);
    payload.extend([0u8; 12]);
    payload.extend(name);
    iso_box(b"hdlr", &payload)
}

fn minf(track: &AudioTrack, count: u32, chunk_offset: u32) -> Result<Vec<u8>, ExtractError> {
    let mut payload = smhd()?;
    payload.extend(dinf()?);
    payload.extend(stbl(track, count, chunk_offset)?);
    iso_box(b"minf", &payload)
}

fn smhd() -> Result<Vec<u8>, ExtractError> {
    iso_box(b"smhd", &[0, 0, 0, 0, 0, 0, 0, 0])
}

fn dinf() -> Result<Vec<u8>, ExtractError> {
    let url = iso_box(b"url ", &1u32.to_be_bytes())?;
    let mut dref = Vec::new();
    dref.extend(0u32.to_be_bytes());
    dref.extend(1u32.to_be_bytes());
    dref.extend(url);
    let dref = iso_box(b"dref", &dref)?;
    iso_box(b"dinf", &dref)
}

fn stbl(track: &AudioTrack, count: u32, chunk_offset: u32) -> Result<Vec<u8>, ExtractError> {
    let mut payload = stsd(&track.sample_entry)?;
    payload.extend(match &track.stts {
        Some(stts) => stts.clone(),
        None => stts_one(count)?,
    });
    payload.extend(stsc_one(count)?);
    payload.extend(stsz(&track.sizes)?);
    payload.extend(stco(chunk_offset)?);
    iso_box(b"stbl", &payload)
}

fn stsd(entry: &[u8]) -> Result<Vec<u8>, ExtractError> {
    let mut payload = Vec::new();
    payload.extend(0u32.to_be_bytes());
    payload.extend(1u32.to_be_bytes());
    payload.extend(entry);
    iso_box(b"stsd", &payload)
}

fn stts_one(count: u32) -> Result<Vec<u8>, ExtractError> {
    let mut payload = Vec::new();
    payload.extend(0u32.to_be_bytes());
    payload.extend(1u32.to_be_bytes());
    payload.extend(count.to_be_bytes());
    payload.extend(1024u32.to_be_bytes());
    iso_box(b"stts", &payload)
}

fn stsc_one(count: u32) -> Result<Vec<u8>, ExtractError> {
    let mut payload = Vec::new();
    payload.extend(0u32.to_be_bytes());
    payload.extend(1u32.to_be_bytes());
    payload.extend(1u32.to_be_bytes());
    payload.extend(count.to_be_bytes());
    payload.extend(1u32.to_be_bytes());
    iso_box(b"stsc", &payload)
}

fn stsz(sizes: &[u32]) -> Result<Vec<u8>, ExtractError> {
    let count = u32::try_from(sizes.len()).map_err(|_| ExtractError::BadAudio)?;
    let mut payload = Vec::new();
    payload.extend(0u32.to_be_bytes());
    payload.extend(0u32.to_be_bytes());
    payload.extend(count.to_be_bytes());
    for size in sizes {
        payload.extend(size.to_be_bytes());
    }
    iso_box(b"stsz", &payload)
}

fn stco(offset: u32) -> Result<Vec<u8>, ExtractError> {
    let mut payload = Vec::new();
    payload.extend(0u32.to_be_bytes());
    payload.extend(1u32.to_be_bytes());
    payload.extend(offset.to_be_bytes());
    iso_box(b"stco", &payload)
}

fn push_matrix(payload: &mut Vec<u8>) {
    for value in [0x00010000u32, 0, 0, 0, 0x00010000, 0, 0, 0, 0x40000000] {
        payload.extend(value.to_be_bytes());
    }
}

fn iso_box(typ: &[u8; 4], payload: &[u8]) -> Result<Vec<u8>, ExtractError> {
    let size = 8usize
        .checked_add(payload.len())
        .ok_or(ExtractError::BadAudio)?;
    let size = u32::try_from(size).map_err(|_| ExtractError::BadAudio)?;
    let mut out = Vec::with_capacity(size as usize);
    out.extend(size.to_be_bytes());
    out.extend(typ);
    out.extend(payload);
    Ok(out)
}

fn top_atoms(data: &[u8]) -> Result<Vec<Atom>, ExtractError> {
    if data.len() < 8 {
        return Err(ExtractError::BadAudio);
    }
    let mut atoms = Vec::new();
    let mut pos = 0;
    while pos + 8 <= data.len() {
        let atom = read_atom(data, pos, data.len())?;
        if atom.end <= pos {
            return Err(ExtractError::BadAudio);
        }
        pos = atom.end;
        atoms.push(atom);
    }
    if atoms.is_empty() {
        return Err(ExtractError::BadAudio);
    }
    Ok(atoms)
}

fn children(data: &[u8], start: usize, end: usize) -> Result<Vec<Atom>, ExtractError> {
    let mut atoms = Vec::new();
    let mut pos = start;
    while pos + 8 <= end {
        let atom = read_atom(data, pos, end)?;
        if atom.end <= pos {
            return Err(ExtractError::BadAudio);
        }
        pos = atom.end;
        atoms.push(atom);
    }
    Ok(atoms)
}

fn child(
    data: &[u8],
    start: usize,
    end: usize,
    typ: &[u8; 4],
) -> Result<Option<Atom>, ExtractError> {
    Ok(children(data, start, end)?
        .into_iter()
        .find(|atom| &atom.typ == typ))
}

fn required_child(data: &[u8], parent: &Atom, typ: &[u8; 4]) -> Result<Atom, ExtractError> {
    child(data, parent.payload_start, parent.payload_end, typ)?.ok_or(ExtractError::BadAudio)
}

fn read_atom(data: &[u8], offset: usize, limit: usize) -> Result<Atom, ExtractError> {
    if offset.checked_add(8).map(|end| end > limit).unwrap_or(true) {
        return Err(ExtractError::BadAudio);
    }
    let size32 = read_u32(data, offset)?;
    let typ = data[offset + 4..offset + 8]
        .try_into()
        .map_err(|_| ExtractError::BadAudio)?;
    let (header, total) = if size32 == 1 {
        if offset
            .checked_add(16)
            .map(|end| end > limit)
            .unwrap_or(true)
        {
            return Err(ExtractError::BadAudio);
        }
        let large = read_u64(data, offset + 8)?;
        if large < 16 {
            return Err(ExtractError::BadAudio);
        }
        (
            16usize,
            usize::try_from(large).map_err(|_| ExtractError::BadAudio)?,
        )
    } else if size32 == 0 {
        (8usize, limit - offset)
    } else {
        if size32 < 8 {
            return Err(ExtractError::BadAudio);
        }
        (8usize, size32 as usize)
    };
    let end = offset.checked_add(total).ok_or(ExtractError::BadAudio)?;
    if end > limit || header > total {
        return Err(ExtractError::BadAudio);
    }
    Ok(Atom {
        typ,
        start: offset,
        payload_start: offset + header,
        payload_end: end,
        end,
    })
}

fn handler_type(data: &[u8], hdlr: &Atom) -> Result<[u8; 4], ExtractError> {
    let payload = &data[hdlr.payload_start..hdlr.payload_end];
    if payload.len() < 12 {
        return Err(ExtractError::BadAudio);
    }
    payload[8..12]
        .try_into()
        .map_err(|_| ExtractError::BadAudio)
}

fn parse_mdhd(data: &[u8], mdhd: &Atom) -> Result<(u32, u64), ExtractError> {
    let payload = &data[mdhd.payload_start..mdhd.payload_end];
    if payload.is_empty() {
        return Err(ExtractError::BadAudio);
    }
    match payload[0] {
        0 => {
            if payload.len() < 20 {
                return Err(ExtractError::BadAudio);
            }
            Ok((read_u32(payload, 12)?, u64::from(read_u32(payload, 16)?)))
        }
        1 => {
            if payload.len() < 32 {
                return Err(ExtractError::BadAudio);
            }
            Ok((read_u32(payload, 20)?, read_u64(payload, 24)?))
        }
        _ => Err(ExtractError::BadAudio),
    }
}

fn stsd_entries(data: &[u8], stsd: &Atom) -> Result<Vec<Atom>, ExtractError> {
    let start = stsd
        .payload_start
        .checked_add(8)
        .ok_or(ExtractError::BadAudio)?;
    if start > stsd.payload_end {
        return Err(ExtractError::BadAudio);
    }
    children(data, start, stsd.payload_end)
}

fn parse_stsz(data: &[u8], stsz: &Atom) -> Result<Vec<u32>, ExtractError> {
    let payload = &data[stsz.payload_start..stsz.payload_end];
    if payload.len() < 12 {
        return Err(ExtractError::BadAudio);
    }
    let fixed = read_u32(payload, 4)?;
    let count = read_u32(payload, 8)?;
    if count > 2_000_000 {
        return Err(ExtractError::BadAudio);
    }
    let count = count as usize;
    if fixed != 0 {
        return Ok(vec![fixed; count]);
    }
    let need = 12usize
        .checked_add(count.checked_mul(4).ok_or(ExtractError::BadAudio)?)
        .ok_or(ExtractError::BadAudio)?;
    if payload.len() < need {
        return Err(ExtractError::BadAudio);
    }
    let mut sizes = Vec::with_capacity(count);
    for index in 0..count {
        sizes.push(read_u32(payload, 12 + index * 4)?);
    }
    Ok(sizes)
}

fn parse_chunks(data: &[u8], stbl: &Atom) -> Result<Vec<u64>, ExtractError> {
    if let Some(co64) = child(data, stbl.payload_start, stbl.payload_end, b"co64")? {
        return parse_offset_table(data, &co64, true);
    }
    let stco = required_child(data, stbl, b"stco")?;
    parse_offset_table(data, &stco, false)
}

fn parse_offset_table(data: &[u8], atom: &Atom, wide: bool) -> Result<Vec<u64>, ExtractError> {
    let payload = &data[atom.payload_start..atom.payload_end];
    if payload.len() < 8 {
        return Err(ExtractError::BadAudio);
    }
    let count = read_u32(payload, 4)? as usize;
    if count > 2_000_000 {
        return Err(ExtractError::BadAudio);
    }
    let width = if wide { 8 } else { 4 };
    let need = 8usize
        .checked_add(count.checked_mul(width).ok_or(ExtractError::BadAudio)?)
        .ok_or(ExtractError::BadAudio)?;
    if payload.len() < need {
        return Err(ExtractError::BadAudio);
    }
    let mut offsets = Vec::with_capacity(count);
    for index in 0..count {
        let at = 8 + index * width;
        offsets.push(if wide {
            read_u64(payload, at)?
        } else {
            u64::from(read_u32(payload, at)?)
        });
    }
    Ok(offsets)
}

fn parse_stsc(data: &[u8], stsc: &Atom) -> Result<Vec<SampleRun>, ExtractError> {
    let payload = &data[stsc.payload_start..stsc.payload_end];
    if payload.len() < 8 {
        return Err(ExtractError::BadAudio);
    }
    let count = read_u32(payload, 4)? as usize;
    if count == 0 || count > 2_000_000 {
        return Err(ExtractError::BadAudio);
    }
    let need = 8usize
        .checked_add(count.checked_mul(12).ok_or(ExtractError::BadAudio)?)
        .ok_or(ExtractError::BadAudio)?;
    if payload.len() < need {
        return Err(ExtractError::BadAudio);
    }
    let mut runs = Vec::with_capacity(count);
    for index in 0..count {
        let at = 8 + index * 12;
        runs.push(SampleRun {
            first_chunk: read_u32(payload, at)?,
            samples_per_chunk: read_u32(payload, at + 4)?,
            description: read_u32(payload, at + 8)?,
        });
    }
    runs.sort_by_key(|run| run.first_chunk);
    Ok(runs)
}

fn matching_stts(
    data: &[u8],
    stbl: &Atom,
    samples: usize,
) -> Result<Option<Vec<u8>>, ExtractError> {
    let Some(stts) = child(data, stbl.payload_start, stbl.payload_end, b"stts")? else {
        return Ok(None);
    };
    let payload = &data[stts.payload_start..stts.payload_end];
    if payload.len() < 8 {
        return Ok(None);
    }
    let count = read_u32(payload, 4)? as usize;
    let need = 8usize.saturating_add(count.saturating_mul(8));
    if count > 2_000_000 || payload.len() < need {
        return Ok(None);
    }
    let mut total = 0usize;
    for index in 0..count {
        let samples_here = read_u32(payload, 8 + index * 8)? as usize;
        total = total.saturating_add(samples_here);
    }
    if total != samples {
        return Ok(None);
    }
    Ok(Some(data[stts.start..stts.end].to_vec()))
}

fn read_u32(data: &[u8], at: usize) -> Result<u32, ExtractError> {
    let bytes = data
        .get(at..at + 4)
        .ok_or(ExtractError::BadAudio)?
        .try_into()
        .map_err(|_| ExtractError::BadAudio)?;
    Ok(u32::from_be_bytes(bytes))
}

fn read_u64(data: &[u8], at: usize) -> Result<u64, ExtractError> {
    let bytes = data
        .get(at..at + 8)
        .ok_or(ExtractError::BadAudio)?
        .try_into()
        .map_err(|_| ExtractError::BadAudio)?;
    Ok(u64::from_be_bytes(bytes))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn audio_entry() -> Vec<u8> {
        let mut payload = vec![0u8; 28];
        payload.extend(iso_box(b"esds", b"config").unwrap());
        iso_box(b"mp4a", &payload).unwrap()
    }

    fn table_with(sizes: &[u32], offsets: &[u64], wide: bool, per_chunk: u32) -> Vec<u8> {
        let mut payload = stsd(&audio_entry()).unwrap();
        payload.extend(stts_one(sizes.len() as u32).unwrap());
        let mut stsc = Vec::new();
        stsc.extend(0u32.to_be_bytes());
        stsc.extend(1u32.to_be_bytes());
        stsc.extend(1u32.to_be_bytes());
        stsc.extend(per_chunk.to_be_bytes());
        stsc.extend(1u32.to_be_bytes());
        payload.extend(iso_box(b"stsc", &stsc).unwrap());
        payload.extend(stsz(sizes).unwrap());
        payload.extend(offset_box(offsets, wide).unwrap());
        iso_box(b"stbl", &payload).unwrap()
    }

    fn offset_box(offsets: &[u64], wide: bool) -> Result<Vec<u8>, ExtractError> {
        let mut payload = Vec::new();
        payload.extend(0u32.to_be_bytes());
        payload.extend((offsets.len() as u32).to_be_bytes());
        for offset in offsets {
            if wide {
                payload.extend(offset.to_be_bytes());
            } else {
                payload.extend((*offset as u32).to_be_bytes());
            }
        }
        iso_box(if wide { b"co64" } else { b"stco" }, &payload)
    }

    fn sound_trak(sizes: &[u32], offsets: &[u64], wide: bool) -> Vec<u8> {
        sound_trak_with(sizes, offsets, wide, 1)
    }

    fn sound_trak_with(sizes: &[u32], offsets: &[u64], wide: bool, per_chunk: u32) -> Vec<u8> {
        let mut mdia_payload = mdhd(44_100, 2048).unwrap();
        mdia_payload.extend(hdlr(b"soun", b"SoundHandler\0").unwrap());
        let mut minf = smhd().unwrap();
        minf.extend(dinf().unwrap());
        minf.extend(table_with(sizes, offsets, wide, per_chunk));
        mdia_payload.extend(iso_box(b"minf", &minf).unwrap());
        let mdia = iso_box(b"mdia", &mdia_payload).unwrap();
        iso_box(b"trak", &mdia).unwrap()
    }

    fn video_trak() -> Vec<u8> {
        let hdlr = hdlr(b"vide", b"VideoHandler\0").unwrap();
        let mdia = iso_box(b"mdia", &hdlr).unwrap();
        iso_box(b"trak", &mdia).unwrap()
    }

    fn source(mdat_first: bool, wide: bool) -> Vec<u8> {
        let junk = b"XXXX";
        let first = b"AAA";
        let second = b"BBBB";
        let mut blob = Vec::new();
        blob.extend(junk);
        let first_at = blob.len();
        blob.extend(first);
        blob.extend(junk);
        let second_at = blob.len();
        blob.extend(second);
        let mdat = iso_box(b"mdat", &blob).unwrap();
        let ftyp = iso_box(b"ftyp", &ftyp_payload()).unwrap();
        let probe = sound_trak(&[3, 4], &[0, 0], wide);
        let moov_body = {
            let mut body = mvhd(44_100, 2048).unwrap();
            body.extend(video_trak());
            body.extend(probe);
            body
        };
        let moov_len = iso_box(b"moov", &moov_body).unwrap().len();
        let base = if mdat_first {
            ftyp.len() + 8
        } else {
            ftyp.len() + moov_len + 8
        };
        let trak = sound_trak(
            &[3, 4],
            &[(base + first_at) as u64, (base + second_at) as u64],
            wide,
        );
        let mut body = mvhd(44_100, 2048).unwrap();
        body.extend(video_trak());
        body.extend(trak);
        let moov = iso_box(b"moov", &body).unwrap();
        assert_eq!(moov.len(), moov_len);
        let mut file = ftyp;
        if mdat_first {
            file.extend(mdat);
            file.extend(moov);
        } else {
            file.extend(moov);
            file.extend(mdat);
        }
        file
    }

    #[test]
    fn aac_samples_survive_a_video_container() {
        for (mdat_first, wide) in [(false, false), (true, false), (false, true)] {
            let file = source(mdat_first, wide);
            let audio = aac_m4a(&file).unwrap();
            assert_eq!(crate::voice::audio_filename(&audio), "note.m4a");
            let mp4a = audio
                .windows(4)
                .position(|window| window == b"mp4a")
                .unwrap();
            assert_eq!(&audio[mp4a + 10..mp4a + 12], &[0, 1]);
            assert!(audio.windows(7).any(|window| window == b"AAABBBB"));
            assert!(!audio.windows(4).any(|window| window == b"XXXX"));
            let again = aac_m4a(&audio).unwrap();
            assert!(again.windows(7).any(|window| window == b"AAABBBB"));
        }
    }

    #[test]
    fn a_video_without_audio_is_refused() {
        let mut body = mvhd(44_100, 100).unwrap();
        body.extend(video_trak());
        let file = iso_box(b"moov", &body).unwrap();
        assert_eq!(aac_m4a(&file), Err(ExtractError::NoAudio));
    }

    #[test]
    fn a_fragmented_file_and_a_non_aac_track_are_refused() {
        let mut fragmented = iso_box(b"ftyp", b"isom").unwrap();
        fragmented.extend(iso_box(b"moof", &[]).unwrap());
        assert_eq!(aac_m4a(&fragmented), Err(ExtractError::BadAudio));

        let hdlr = hdlr(b"soun", b"SoundHandler\0").unwrap();
        let entry = iso_box(b"samr", &[0u8; 8]).unwrap();
        let stsd = stsd(&entry).unwrap();
        let stbl = iso_box(b"stbl", &stsd).unwrap();
        let minf = iso_box(b"minf", &stbl).unwrap();
        let mut mdia = hdlr;
        mdia.extend(minf);
        let mdia = iso_box(b"mdia", &mdia).unwrap();
        let trak = iso_box(b"trak", &mdia).unwrap();
        let mut body = mvhd(44_100, 100).unwrap();
        body.extend(trak);
        let file = iso_box(b"moov", &body).unwrap();
        assert_eq!(aac_m4a(&file), Err(ExtractError::BadAudio));
    }

    fn file_from_chunks(parts: &[&[u8]], per_chunk: u32, groups: &[&[usize]]) -> Vec<u8> {
        let sizes: Vec<u32> = parts.iter().map(|part| part.len() as u32).collect();
        let mut blob = Vec::new();
        let mut local = Vec::new();
        for group in groups {
            if !blob.is_empty() {
                blob.extend(b"XXXX");
            }
            local.push(blob.len());
            for index in *group {
                blob.extend(parts[*index]);
            }
        }
        let mdat = iso_box(b"mdat", &blob).unwrap();
        let ftyp = iso_box(b"ftyp", &ftyp_payload()).unwrap();
        let zeros = vec![0u64; local.len()];
        let probe = sound_trak_with(&sizes, &zeros, false, per_chunk);
        let mut moov_body = mvhd(44_100, 2048).unwrap();
        moov_body.extend(probe);
        let moov_len = iso_box(b"moov", &moov_body).unwrap().len();
        let base = ftyp.len() + moov_len + 8;
        let offsets: Vec<u64> = local.iter().map(|at| (base + *at) as u64).collect();
        let trak = sound_trak_with(&sizes, &offsets, false, per_chunk);
        let mut body = mvhd(44_100, 2048).unwrap();
        body.extend(trak);
        let moov = iso_box(b"moov", &body).unwrap();
        assert_eq!(moov.len(), moov_len);
        let mut file = ftyp;
        file.extend(moov);
        file.extend(mdat);
        file
    }

    #[test]
    fn the_last_aac_chunk_may_hold_fewer_samples() {
        let parts: [&[u8]; 5] = [b"A", b"BB", b"CCC", b"DDDD", b"EEEEE"];
        let file = file_from_chunks(&parts, 3, &[&[0, 1, 2], &[3, 4]]);
        let audio = aac_m4a(&file).unwrap();
        assert!(audio.windows(15).any(|window| window == b"ABBCCCDDDDEEEEE"));
        assert!(!audio.windows(4).any(|window| window == b"XXXX"));
    }

    #[test]
    fn a_short_chunk_before_the_last_is_refused() {
        let parts: [&[u8]; 5] = [b"A", b"BB", b"CCC", b"DDDD", b"EEEEE"];
        let file = file_from_chunks(&parts, 3, &[&[0, 1, 2], &[3, 4], &[4]]);
        assert_eq!(aac_m4a(&file), Err(ExtractError::BadAudio));
    }

    #[test]
    fn a_sample_entry_points_at_the_audio_in_this_file() {
        let mut entry = audio_entry();
        entry[0..4].copy_from_slice(&0u32.to_be_bytes());
        let fixed = prepared_sample_entry(&entry);
        assert_eq!(&fixed[0..4], &(fixed.len() as u32).to_be_bytes());
        assert_eq!(&fixed[14..16], &[0, 1]);
    }
}
