//! Turn a 16-bit PCM WAV into an Ogg Opus voice note.
//!
//! WhatsApp rejects a push-to-talk recording unless the bytes are Ogg Opus
//! (`InvalidMediaCheckRepairFailedType`). The reply popup records whatever the
//! webview can produce, usually MP4 on macOS, and converts that to WAV before
//! it gets here. This module encodes the WAV and muxes a minimal Ogg stream.

use opus_rs::{Application, OpusEncoder};

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
}

impl VoiceError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::NotPcm => "not_pcm",
            Self::Empty => "empty",
            Self::Encode => "encode",
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

/// 16-bit little-endian PCM in a plain RIFF WAVE container.
#[cfg(test)]
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
    if channels == 0 || pcm.len() % (channels * 2) != 0 {
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
    let mut lacing = Vec::new();
    let mut rest = packet.len();
    if packet.is_empty() {
        lacing.push(0u8);
    } else {
        while rest >= 255 {
            lacing.push(255);
            rest -= 255;
        }
        lacing.push(rest as u8);
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
    out.extend_from_slice(packet);
    let crc = ogg_crc(&out[start..]);
    out[start + 22..start + 26].copy_from_slice(&crc.to_le_bytes());
    Ok(())
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
