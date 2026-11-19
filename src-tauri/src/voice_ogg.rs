//! Turn a 16-bit PCM WAV into an Ogg Opus voice note.
//!
//! WhatsApp rejects a push-to-talk recording unless the bytes are Ogg Opus
//! (`InvalidMediaCheckRepairFailedType`). The reply popup records whatever the
//! webview can produce, usually MP4 on macOS, and converts that to WAV before
//! it gets here. This module encodes the WAV and muxes a minimal Ogg stream.

use opus_rs::{Application, OpusDecoder, OpusEncoder};
use std::mem::MaybeUninit;

const RATE: u32 = 16_000;
const FRAME: usize = 320;
/// One 20 ms frame, counted in the 48 kHz units an Opus granule position uses.
const GRANULE_STEP: i64 = 960;
const MAX_PACKET: usize = 4_000;

#[derive(Debug, PartialEq, Eq)]
pub enum VoiceError {
    NotPcm,
    Empty,
    Encode,
    TooLong,
}

impl VoiceError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::NotPcm => "not_pcm",
            Self::Empty => "empty",
            Self::Encode => "encode",
            Self::TooLong => "too_long",
        }
    }
}

pub fn ogg_opus_from_wav(wav: &[u8]) -> Result<Vec<u8>, VoiceError> {
    let (rate, channels, pcm) = wav_pcm(wav)?;
    let mono = downmix(pcm, channels)?;
    let samples = resample(&mono, rate, RATE);
    if samples.is_empty() {
        return Err(VoiceError::Empty);
    }
    let mut encoder =
        OpusEncoder::new(RATE as i32, 1, Application::Voip).map_err(|_| VoiceError::Encode)?;
    encoder.bitrate_bps = 24_000;
    let mut packet = [0u8; MAX_PACKET];
    let mut out = Vec::new();
    let serial = 0x5752_5553;
    let mut seq = 0u32;
    write_page(&mut out, 0x02, 0, serial, seq, &opus_head())?;
    seq += 1;
    write_page(&mut out, 0x00, 0, serial, seq, &opus_tags())?;
    seq += 1;
    let mut granule = 0i64;
    let mut offset = 0usize;
    while offset < samples.len() {
        let mut frame = [0i16; FRAME];
        let n = (samples.len() - offset).min(FRAME);
        frame[..n].copy_from_slice(&samples[offset..offset + n]);
        offset += n;
        let len = encoder
            .encode_i16(&frame, FRAME, &mut packet)
            .map_err(|_| VoiceError::Encode)?;
        if len == 0 {
            return Err(VoiceError::Encode);
        }
        granule += GRANULE_STEP;
        let flags = if offset >= samples.len() { 0x04 } else { 0x00 };
        write_page(&mut out, flags, granule, serial, seq, &packet[..len])?;
        seq += 1;
    }
    Ok(out)
}

/// Decode an Ogg Opus voice note to 16 kHz mono WAV. The popup's webview plays
/// WAV; it does not play the Ogg Opus file WhatsApp stores.
pub fn wav_from_ogg(data: &[u8]) -> Result<Vec<u8>, VoiceError> {
    let packets = ogg_packets(data)?;
    let mut audio = Vec::new();
    let mut head = false;
    for packet in packets {
        if packet.starts_with(b"OpusHead") {
            head = true;
            continue;
        }
        if packet.starts_with(b"OpusTags") || packet.len() <= 1 {
            continue;
        }
        audio.push(packet);
    }
    if !head || audio.is_empty() {
        return Err(VoiceError::NotPcm);
    }
    let mut slot = Box::new(MaybeUninit::<OpusDecoder>::uninit());
    let decoder =
        OpusDecoder::init(slot.as_mut(), RATE as i32, 1).map_err(|_| VoiceError::Encode)?;
    let mut pcm = vec![0f32; 2_880];
    let mut samples = Vec::new();
    for packet in &audio {
        // A comment or padding packet in the middle of a note is not fatal.
        let Ok(n) = decoder.decode(packet, pcm.len(), &mut pcm) else {
            continue;
        };
        let n = n.min(pcm.len());
        if samples.len().saturating_add(n) > RATE as usize * 60 * 6 {
            return Err(VoiceError::TooLong);
        }
        for sample in &pcm[..n] {
            let clipped = sample.clamp(-1.0, 1.0);
            samples.push((clipped * i16::MAX as f32) as i16);
        }
    }
    if samples.is_empty() {
        return Err(VoiceError::Empty);
    }
    Ok(pcm_wav(&samples, RATE, 1))
}

fn ogg_packets(data: &[u8]) -> Result<Vec<Vec<u8>>, VoiceError> {
    let mut packets = Vec::new();
    let mut partial = Vec::new();
    let mut i = 0usize;
    while i + 27 <= data.len() {
        if &data[i..i + 4] != b"OggS" {
            return Err(VoiceError::NotPcm);
        }
        let segs = data[i + 26] as usize;
        let table_end = i + 27 + segs;
        if table_end > data.len() {
            return Err(VoiceError::NotPcm);
        }
        let table = &data[i + 27..table_end];
        let payload: usize = table.iter().map(|n| *n as usize).sum();
        let end = table_end + payload;
        if end > data.len() {
            return Err(VoiceError::NotPcm);
        }
        let mut offset = table_end;
        for &lace in table {
            let n = lace as usize;
            partial.extend_from_slice(&data[offset..offset + n]);
            offset += n;
            if lace < 255 {
                packets.push(std::mem::take(&mut partial));
            }
        }
        i = end;
    }
    // A packet that ran off the last page is truncated. A few trailing bytes
    // after a finished page show up on some voice notes and are not audio.
    if !partial.is_empty() {
        return Err(VoiceError::NotPcm);
    }
    if i < data.len() && data[i..].starts_with(b"OggS") {
        return Err(VoiceError::NotPcm);
    }
    Ok(packets)
}

/// WhatsApp packs several Opus frames into one packet, and a silent moment is a
/// frame of length zero. Apple's decoder, which FluidVoice uses, stops on that
/// packet (`OSStatus -39`) and refuses the whole note. A note that parses
/// cleanly is returned unchanged. Otherwise the real frames are written back
/// as ordinary single-frame packets.
pub(crate) fn repair_opus(data: &[u8]) -> Option<Vec<u8>> {
    let packets = ogg_packets(data).ok()?;
    let head = packets
        .iter()
        .find(|packet| packet.starts_with(b"OpusHead"))?;
    let tags = packets
        .iter()
        .find(|packet| packet.starts_with(b"OpusTags"))?;
    let mut frames = Vec::new();
    let mut repair = false;
    for packet in &packets {
        if packet.starts_with(b"OpusHead") || packet.starts_with(b"OpusTags") {
            continue;
        }
        match split_opus_packet(packet) {
            Ok(split) => {
                if split.iter().any(|frame| frame.data.is_empty()) {
                    repair = true;
                }
                frames.extend(split.into_iter().filter(|frame| !frame.data.is_empty()));
            }
            Err(()) => repair = true,
        }
    }
    if !repair || frames.is_empty() {
        return None;
    }
    remux_opus(head, tags, &frames).ok()
}

struct OpusFrame {
    toc: u8,
    data: Vec<u8>,
    samples: i64,
}

fn frame_samples(toc: u8) -> i64 {
    let config = usize::from(toc >> 3);
    const SILK: [i64; 4] = [480, 960, 1920, 2880];
    const SHORT: [i64; 2] = [480, 960];
    const CELT: [i64; 4] = [120, 240, 480, 960];
    match config {
        0..=11 => SILK[config % 4],
        12..=15 => SHORT[config % 2],
        _ => CELT[config % 4],
    }
}

fn split_opus_packet(packet: &[u8]) -> Result<Vec<OpusFrame>, ()> {
    let toc = *packet.first().ok_or(())?;
    let samples = frame_samples(toc);
    let plain = toc & 0xFC;
    let code = toc & 0x03;
    let frame = |data: &[u8]| OpusFrame {
        toc: plain,
        data: data.to_vec(),
        samples,
    };
    if code == 0 {
        return Ok(vec![frame(&packet[1..])]);
    }
    if code == 1 {
        let body = &packet[1..];
        if body.len() < 2 || !body.len().is_multiple_of(2) {
            return Err(());
        }
        let half = body.len() / 2;
        return Ok(vec![frame(&body[..half]), frame(&body[half..])]);
    }
    if code == 2 {
        let (size, pos) = parse_frame_size(packet, 1)?;
        let end = pos.checked_add(size).ok_or(())?;
        if end > packet.len() {
            return Err(());
        }
        return Ok(vec![frame(&packet[pos..end]), frame(&packet[end..])]);
    }
    let flags = *packet.get(1).ok_or(())?;
    let count = usize::from(flags & 0x3F);
    if count == 0 {
        return Err(());
    }
    let mut pos = 2usize;
    let mut sizes = Vec::new();
    if flags & 0x80 != 0 {
        for _ in 0..count - 1 {
            let (size, next) = parse_frame_size(packet, pos)?;
            sizes.push(size);
            pos = next;
        }
    }
    let mut padding = 0usize;
    if flags & 0x40 != 0 {
        loop {
            let byte = *packet.get(pos).ok_or(())?;
            pos += 1;
            if byte == 255 {
                padding += 254;
            } else {
                padding += usize::from(byte);
                break;
            }
        }
    }
    let end = packet.len().checked_sub(padding).ok_or(())?;
    if end < pos {
        return Err(());
    }
    let body = &packet[pos..end];
    if flags & 0x80 != 0 {
        let used: usize = sizes.iter().sum();
        if used > body.len() {
            return Err(());
        }
        let mut frames = Vec::with_capacity(count);
        let mut offset = 0usize;
        for size in sizes {
            frames.push(frame(&body[offset..offset + size]));
            offset += size;
        }
        frames.push(frame(&body[offset..]));
        return Ok(frames);
    }
    if !body.len().is_multiple_of(count) {
        return Err(());
    }
    let each = body.len() / count;
    Ok((0..count)
        .map(|index| frame(&body[index * each..(index + 1) * each]))
        .collect())
}

/// A frame shorter than 252 bytes uses one length byte. A longer frame uses
/// two: `first + 4 * second`.
fn parse_frame_size(data: &[u8], pos: usize) -> Result<(usize, usize), ()> {
    let first = usize::from(*data.get(pos).ok_or(())?);
    if first < 252 {
        return Ok((first, pos + 1));
    }
    let second = usize::from(*data.get(pos + 1).ok_or(())?);
    Ok((first + 4 * second, pos + 2))
}

fn remux_opus(head: &[u8], tags: &[u8], frames: &[OpusFrame]) -> Result<Vec<u8>, VoiceError> {
    let packets: Vec<Vec<u8>> = frames
        .iter()
        .map(|frame| {
            let mut packet = Vec::with_capacity(1 + frame.data.len());
            packet.push(frame.toc);
            packet.extend_from_slice(&frame.data);
            packet
        })
        .collect();
    let mut out = Vec::new();
    let serial = 0x5752_5553u32;
    let mut sequence = 0u32;
    write_packets(&mut out, 0x02, 0, serial, sequence, &[head])?;
    sequence += 1;
    write_packets(&mut out, 0x00, 0, serial, sequence, &[tags])?;
    sequence += 1;
    let mut granule = if head.len() >= 12 {
        i64::from(u16::from_le_bytes([head[10], head[11]]))
    } else {
        0
    };
    let mut index = 0usize;
    while index < packets.len() {
        let mut lacing = 0usize;
        let mut end = index;
        let mut page_granule = granule;
        while end < packets.len() {
            let needed = lacing_segments(&packets[end]);
            if end > index && (lacing + needed > 255 || end - index >= 48) {
                break;
            }
            if needed > 255 {
                return Err(VoiceError::Encode);
            }
            lacing += needed;
            page_granule += frames[end].samples;
            end += 1;
        }
        if end == index {
            return Err(VoiceError::Encode);
        }
        let flags = if end == packets.len() { 0x04 } else { 0x00 };
        let page: Vec<&[u8]> = packets[index..end].iter().map(Vec::as_slice).collect();
        write_packets(&mut out, flags, page_granule, serial, sequence, &page)?;
        sequence += 1;
        granule = page_granule;
        index = end;
    }
    Ok(out)
}

fn lacing_segments(packet: &[u8]) -> usize {
    if packet.is_empty() {
        1
    } else {
        packet.len().div_ceil(255)
    }
}

fn write_packets(
    out: &mut Vec<u8>,
    header_type: u8,
    granule: i64,
    serial: u32,
    sequence: u32,
    packets: &[&[u8]],
) -> Result<(), VoiceError> {
    if packets.is_empty() {
        return Err(VoiceError::Encode);
    }
    let mut lacing = Vec::new();
    for packet in packets {
        let mut rest = packet.len();
        if rest == 0 {
            lacing.push(0);
        } else {
            while rest >= 255 {
                lacing.push(255);
                rest -= 255;
            }
            lacing.push(rest as u8);
        }
    }
    if lacing.len() > 255 {
        return Err(VoiceError::Encode);
    }
    let start = out.len();
    out.extend_from_slice(b"OggS");
    out.push(0);
    out.push(header_type);
    out.extend_from_slice(&granule.to_le_bytes());
    out.extend_from_slice(&serial.to_le_bytes());
    out.extend_from_slice(&sequence.to_le_bytes());
    out.extend_from_slice(&0u32.to_le_bytes());
    out.push(lacing.len() as u8);
    out.extend_from_slice(&lacing);
    for packet in packets {
        out.extend_from_slice(packet);
    }
    let crc = ogg_crc(&out[start..]);
    out[start + 22..start + 26].copy_from_slice(&crc.to_le_bytes());
    Ok(())
}

/// 16-bit little-endian PCM in a plain RIFF WAVE container.
pub(crate) fn pcm_wav(samples: &[i16], rate: u32, channels: u16) -> Vec<u8> {
    let channels = channels.max(1);
    let data_bytes = samples.len() * 2;
    let mut out = Vec::with_capacity(44 + data_bytes);
    out.extend_from_slice(b"RIFF");
    out.extend_from_slice(&(36 + data_bytes as u32).to_le_bytes());
    out.extend_from_slice(b"WAVE");
    out.extend_from_slice(b"fmt ");
    out.extend_from_slice(&16u32.to_le_bytes());
    out.extend_from_slice(&1u16.to_le_bytes());
    out.extend_from_slice(&channels.to_le_bytes());
    out.extend_from_slice(&rate.to_le_bytes());
    out.extend_from_slice(&(rate * u32::from(channels) * 2).to_le_bytes());
    out.extend_from_slice(&(channels * 2).to_le_bytes());
    out.extend_from_slice(&16u16.to_le_bytes());
    out.extend_from_slice(b"data");
    out.extend_from_slice(&(data_bytes as u32).to_le_bytes());
    for sample in samples {
        out.extend_from_slice(&sample.to_le_bytes());
    }
    out
}

fn wav_pcm(data: &[u8]) -> Result<(u32, usize, &[u8]), VoiceError> {
    if data.len() < 44 || &data[0..4] != b"RIFF" || &data[8..12] != b"WAVE" {
        return Err(VoiceError::NotPcm);
    }
    let mut offset = 12usize;
    let mut rate = 0u32;
    let mut channels = 0usize;
    let mut bits = 0u16;
    let mut format = 0u16;
    let mut pcm: Option<&[u8]> = None;
    while offset + 8 <= data.len() {
        let id = [
            data[offset],
            data[offset + 1],
            data[offset + 2],
            data[offset + 3],
        ];
        let size = u32::from_le_bytes(data[offset + 4..offset + 8].try_into().unwrap()) as usize;
        let start = offset + 8;
        if start > data.len() {
            break;
        }
        let end = start.saturating_add(size).min(data.len());
        if &id == b"fmt " && end - start >= 16 {
            format = u16::from_le_bytes([data[start], data[start + 1]]);
            channels = u16::from_le_bytes([data[start + 2], data[start + 3]]) as usize;
            rate = u32::from_le_bytes(data[start + 4..start + 8].try_into().unwrap());
            bits = u16::from_le_bytes([data[start + 14], data[start + 15]]);
        } else if &id == b"data" && pcm.is_none() {
            pcm = Some(&data[start..end]);
        }
        let padded = end + (size & 1);
        offset = padded.min(data.len());
        if end == data.len() {
            break;
        }
    }
    if format != 1 || bits != 16 || rate == 0 || channels == 0 {
        return Err(VoiceError::NotPcm);
    }
    let pcm = pcm.ok_or(VoiceError::NotPcm)?;
    Ok((rate, channels, pcm))
}

fn downmix(pcm: &[u8], channels: usize) -> Result<Vec<i16>, VoiceError> {
    if channels == 0 || !pcm.len().is_multiple_of(channels * 2) {
        return Err(VoiceError::NotPcm);
    }
    let frames = pcm.len() / (channels * 2);
    let mut out = Vec::with_capacity(frames);
    for frame in 0..frames {
        let mut sum = 0i32;
        for channel in 0..channels {
            let at = (frame * channels + channel) * 2;
            sum += i16::from_le_bytes([pcm[at], pcm[at + 1]]) as i32;
        }
        out.push((sum / channels as i32) as i16);
    }
    Ok(out)
}

fn resample(input: &[i16], from: u32, to: u32) -> Vec<i16> {
    if from == to || input.is_empty() {
        return input.to_vec();
    }
    let out_len = (input.len() as u64).saturating_mul(u64::from(to)) / u64::from(from);
    if out_len == 0 {
        return Vec::new();
    }
    let last = input.len() - 1;
    let mut out = Vec::with_capacity(out_len as usize);
    for i in 0..out_len {
        let pos = i as f64 * f64::from(from) / f64::from(to);
        let idx = (pos.floor() as usize).min(last);
        let frac = pos - idx as f64;
        let a = f64::from(input[idx]);
        let b = f64::from(input[(idx + 1).min(last)]);
        let sample = (a + (b - a) * frac).round().clamp(-32768.0, 32767.0);
        out.push(sample as i16);
    }
    out
}

fn opus_head() -> [u8; 19] {
    let mut head = [0u8; 19];
    head[0..8].copy_from_slice(b"OpusHead");
    head[8] = 1;
    head[9] = 1;
    head[12..16].copy_from_slice(&RATE.to_le_bytes());
    head
}

fn opus_tags() -> Vec<u8> {
    let vendor = b"whatRust";
    let mut tags = Vec::with_capacity(16 + vendor.len());
    tags.extend_from_slice(b"OpusTags");
    tags.extend_from_slice(&(vendor.len() as u32).to_le_bytes());
    tags.extend_from_slice(vendor);
    tags.extend_from_slice(&0u32.to_le_bytes());
    tags
}

fn write_page(
    out: &mut Vec<u8>,
    header_type: u8,
    granule: i64,
    serial: u32,
    sequence: u32,
    packet: &[u8],
) -> Result<(), VoiceError> {
    write_packets(out, header_type, granule, serial, sequence, &[packet])
}

const fn crc_table() -> [u32; 256] {
    let mut table = [0u32; 256];
    let mut i = 0;
    while i < 256 {
        let mut r = (i as u32) << 24;
        let mut bit = 0;
        while bit < 8 {
            if r & 0x8000_0000 != 0 {
                r = (r << 1) ^ 0x04c1_1db7;
            } else {
                r <<= 1;
            }
            bit += 1;
        }
        table[i] = r;
        i += 1;
    }
    table
}

fn ogg_crc(data: &[u8]) -> u32 {
    const TABLE: [u32; 256] = crc_table();
    let mut crc = 0u32;
    for &byte in data {
        let index = ((crc >> 24) ^ u32::from(byte)) as usize;
        crc = (crc << 8) ^ TABLE[index];
    }
    crc
}

#[cfg(test)]
mod tests {
    use super::*;
    use opus_rs::OpusDecoder;

    #[test]
    fn the_ogg_crc_table_matches_libogg() {
        const TABLE: [u32; 256] = crc_table();
        assert_eq!(TABLE[0], 0);
        assert_eq!(TABLE[1], 0x04c1_1db7);
        assert_eq!(TABLE[2], 0x0982_3b6e);
        assert_eq!(TABLE[3], 0x0d43_26d9);
    }

    #[test]
    fn a_tone_becomes_ogg_opus_that_decodes() {
        let mut samples = Vec::new();
        for i in 0..3200 {
            let t = i as f32 / RATE as f32;
            let tone = (t * 440.0 * std::f32::consts::TAU).sin();
            samples.push((tone * 8000.0) as i16);
        }
        let ogg = ogg_opus_from_wav(&pcm_wav(&samples, RATE, 1)).unwrap();
        assert!(ogg.starts_with(b"OggS"));
        assert!(ogg.windows(8).any(|window| window == b"OpusHead"));
        assert_pages_crc(&ogg);
        let mut decoder = OpusDecoder::new(RATE as i32, 1).unwrap();
        let mut pcm = vec![0f32; FRAME];
        let mut energy = 0f32;
        for packet in audio_packets(&ogg) {
            let n = decoder.decode(&packet, FRAME, &mut pcm).unwrap();
            energy += pcm[..n].iter().map(|sample| sample * sample).sum::<f32>();
        }
        assert!(energy > 0.01, "decoded energy {energy}");
        let wav = wav_from_ogg(&ogg).unwrap();
        assert!(wav.starts_with(b"RIFF"));
        assert!(wav.len() > 44);
        let mut padded = ogg.clone();
        padded.extend_from_slice(&[0, 0, 0, 0]);
        assert!(wav_from_ogg(&padded).unwrap().starts_with(b"RIFF"));
        assert_eq!(
            wav_from_ogg(&ogg[..ogg.len() - 1]).unwrap_err(),
            VoiceError::NotPcm
        );
    }

    #[test]
    fn stereo_at_another_rate_still_encodes() {
        let wav = pcm_wav(&[0, 1000, -1000, 500, 0, -500], 8_000, 2);
        let ogg = ogg_opus_from_wav(&wav).unwrap();
        assert!(ogg.windows(8).any(|window| window == b"OpusHead"));
    }

    #[test]
    fn a_file_that_is_not_wav_is_refused() {
        assert_eq!(
            ogg_opus_from_wav(b"not a wav").unwrap_err(),
            VoiceError::NotPcm
        );
    }

    fn assert_pages_crc(data: &[u8]) {
        let mut i = 0usize;
        while i + 27 <= data.len() {
            assert_eq!(&data[i..i + 4], b"OggS");
            let segs = data[i + 26] as usize;
            let table = &data[i + 27..i + 27 + segs];
            let payload: usize = table.iter().map(|n| *n as usize).sum();
            let end = i + 27 + segs + payload;
            let mut page = data[i..end].to_vec();
            page[22..26].fill(0);
            let crc = u32::from_le_bytes(data[i + 22..i + 26].try_into().unwrap());
            assert_eq!(ogg_crc(&page), crc);
            i = end;
        }
        assert_eq!(i, data.len());
    }

    fn tone_ogg() -> Vec<u8> {
        let mut samples = Vec::new();
        for i in 0..3200 {
            let t = i as f32 / RATE as f32;
            let tone = (t * 440.0 * std::f32::consts::TAU).sin();
            samples.push((tone * 8000.0) as i16);
        }
        ogg_opus_from_wav(&pcm_wav(&samples, RATE, 1)).unwrap()
    }

    fn one_frame(ogg: &[u8]) -> Vec<u8> {
        ogg_packets(ogg)
            .unwrap()
            .into_iter()
            .find(|packet| !packet.starts_with(b"Opus"))
            .unwrap()
    }

    fn wrap_packets(ogg: &[u8], audio: &[&[u8]]) -> Vec<u8> {
        let packets = ogg_packets(ogg).unwrap();
        let head = packets
            .iter()
            .find(|packet| packet.starts_with(b"OpusHead"))
            .unwrap();
        let tags = packets
            .iter()
            .find(|packet| packet.starts_with(b"OpusTags"))
            .unwrap();
        let mut out = Vec::new();
        write_page(&mut out, 0x02, 0, 1, 0, head).unwrap();
        write_page(&mut out, 0x00, 0, 1, 1, tags).unwrap();
        for (index, packet) in audio.iter().enumerate() {
            let flags = if index + 1 == audio.len() { 0x04 } else { 0x00 };
            write_page(&mut out, flags, 0, 1, 2 + index as u32, packet).unwrap();
        }
        out
    }

    #[test]
    fn a_normal_note_and_a_packed_note_without_silence_are_left_alone() {
        let ogg = tone_ogg();
        assert!(repair_opus(&ogg).is_none());
        let frame_packet = one_frame(&ogg);
        assert!(frame_packet.len() > 1 && frame_packet.len() < 252);
        assert_eq!(frame_packet[0] & 0x03, 0);
        let frame = &frame_packet[1..];
        let mut packed = vec![frame_packet[0] | 0x03, 0x80 | 2, frame.len() as u8];
        packed.extend_from_slice(frame);
        packed.extend_from_slice(frame);
        assert!(repair_opus(&wrap_packets(&ogg, &[&packed])).is_none());
        let mut cbr = vec![frame_packet[0] | 0x03, 2];
        cbr.extend_from_slice(frame);
        cbr.extend_from_slice(frame);
        assert!(repair_opus(&wrap_packets(&ogg, &[&cbr])).is_none());
    }

    #[test]
    fn a_two_byte_frame_length_is_not_treated_as_silence() {
        let ogg = tone_ogg();
        let frame_packet = one_frame(&ogg);
        let frame = &frame_packet[1..];
        let mut packed = vec![frame_packet[0] | 0x03, 0x80 | 2, 252, 0];
        packed.extend(std::iter::repeat(0x11).take(252));
        packed.extend_from_slice(frame);
        // 252 followed by 0 means 252 bytes, so neither frame is empty.
        assert!(repair_opus(&wrap_packets(&ogg, &[&packed])).is_none());
    }

    #[test]
    fn a_silent_frame_packed_into_a_voice_note_is_removed_and_the_speech_decodes() {
        let ogg = tone_ogg();
        let frame_packet = one_frame(&ogg);
        let frame = &frame_packet[1..];
        let mut packed = vec![frame_packet[0] | 0x03, 0x80 | 3, 0, frame.len() as u8];
        packed.extend_from_slice(frame);
        packed.extend_from_slice(frame);
        let repaired = repair_opus(&wrap_packets(&ogg, &[&packed])).unwrap();
        assert_pages_crc(&repaired);
        let audio: Vec<_> = ogg_packets(&repaired)
            .unwrap()
            .into_iter()
            .filter(|packet| !packet.starts_with(b"Opus"))
            .collect();
        assert_eq!(audio.len(), 2);
        assert!(audio
            .iter()
            .all(|packet| packet[0] & 0x03 == 0 && packet.len() > 1));
        let wav = wav_from_ogg(&repaired).unwrap();
        assert!(wav.len() > 44);
    }

    fn audio_packets(data: &[u8]) -> Vec<Vec<u8>> {
        let mut packets = Vec::new();
        let mut i = 0usize;
        while i + 27 <= data.len() {
            let segs = data[i + 26] as usize;
            let table = &data[i + 27..i + 27 + segs];
            let payload: usize = table.iter().map(|n| *n as usize).sum();
            let start = i + 27 + segs;
            let bytes = data[start..start + payload].to_vec();
            if !bytes.starts_with(b"OpusHead") && !bytes.starts_with(b"OpusTags") {
                packets.push(bytes);
            }
            i = start + payload;
        }
        packets
    }
}
