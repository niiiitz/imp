use crate::sinks::tap_dsp::StereoTapRingBuffer;
use crate::viz::AudioTapBuffer;

#[cfg(target_os = "windows")]
use crate::dsp::global_dsp_state;
#[cfg(target_os = "windows")]
use crate::sinks::tap_dsp::{
    reset_global_tap_status, set_global_tap_status, AudioTapStatusSnapshot, TapDspOutput,
};
#[cfg(target_os = "windows")]
use imp_protocol::PlaybackEvent;
#[cfg(target_os = "windows")]
use std::collections::HashSet;
#[cfg(target_os = "windows")]
use std::ffi::c_void;
#[cfg(target_os = "windows")]
use std::sync::atomic::{fence, AtomicBool, AtomicU32, Ordering};
#[cfg(target_os = "windows")]
use std::sync::{Arc, Mutex};
#[cfg(target_os = "windows")]
use std::time::{Duration, Instant};
#[cfg(target_os = "windows")]
use tokio::sync::broadcast;
#[cfg(target_os = "windows")]
use windows::core::{GUID, HRESULT, IUnknown, IUnknown_Vtbl, Interface, PCWSTR, PROPVARIANT};
#[cfg(target_os = "windows")]
use windows::Win32::Devices::FunctionDiscovery::PKEY_Device_FriendlyName;
#[cfg(target_os = "windows")]
use windows::Win32::Foundation::{
    CloseHandle, E_NOINTERFACE, FALSE, HANDLE, S_FALSE, S_OK, TRUE, WAIT_OBJECT_0,
};
#[cfg(target_os = "windows")]
use windows::Win32::Media::Audio::{
    eConsole, eRender, ActivateAudioInterfaceAsync, IActivateAudioInterfaceAsyncOperation,
    IActivateAudioInterfaceCompletionHandler, IActivateAudioInterfaceCompletionHandler_Vtbl,
    IAudioCaptureClient, IAudioClient, IAudioSessionControl2, IAudioSessionManager2, IMMDevice,
    IMMDeviceEnumerator, ISimpleAudioVolume, MMDeviceEnumerator,
    AUDCLNT_BUFFERFLAGS_SILENT, AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_EVENTCALLBACK,
    AUDCLNT_STREAMFLAGS_LOOPBACK, AUDIOCLIENT_ACTIVATION_PARAMS, AUDIOCLIENT_ACTIVATION_PARAMS_0,
    AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK, AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS,
    DEVICE_STATE_ACTIVE, PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE,
    VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK, WAVEFORMATEX, WAVEFORMATEXTENSIBLE,
};
#[cfg(target_os = "windows")]
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CoTaskMemFree, CoUninitialize, IAgileObject, BLOB,
    CLSCTX_ALL, COINIT_MULTITHREADED, STGM_READ,
};
#[cfg(target_os = "windows")]
use windows::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
};
#[cfg(target_os = "windows")]
use windows::Win32::System::Threading::{CreateEventW, SetEvent, WaitForSingleObject};

/// Summary of an active Windows audio render endpoint used to pick a secondary/virtual loopback target.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WindowsRenderEndpointInfo {
    pub id: String,
    pub friendly_name: String,
    pub is_default: bool,
}

/// Selects a non-default secondary/virtual Windows render endpoint (e.g. VB-Audio Virtual Cable,
/// VoiceMeeter, SteelSeries Sonar, or `IMP_WINDOWS_TAP_SINK` override) so Step 2b can isolate
/// Apple Music worker playback for full Rust EQ + Vocal DSP without double audio.
#[allow(dead_code)]
pub(crate) fn select_windows_virtual_loopback_sink(
    endpoints: &[WindowsRenderEndpointInfo],
    env_override: Option<&str>,
) -> Option<WindowsRenderEndpointInfo> {
    if let Some(raw_override) = env_override {
        let needle = raw_override.trim().to_ascii_lowercase();
        if !needle.is_empty() {
            return endpoints
                .iter()
                .find(|ep| {
                    !ep.is_default
                        && (ep.friendly_name.to_ascii_lowercase().contains(&needle)
                            || ep.id.to_ascii_lowercase().contains(&needle))
                })
                .cloned();
        }
    }

    const VIRTUAL_KEYWORDS: &[&str] = &[
        "vb-audio",
        "cable input",
        "voicemeeter",
        "virtual cable",
        "virtual audio",
        "steelseries sonar",
        "virtual desktop audio",
    ];

    endpoints
        .iter()
        .filter(|ep| !ep.is_default)
        .filter_map(|ep| {
            let lower = ep.friendly_name.to_ascii_lowercase();
            VIRTUAL_KEYWORDS
                .iter()
                .position(|kw| lower.contains(kw))
                .map(|rank| (rank, ep))
        })
        .min_by_key(|(rank, _)| *rank)
        .map(|(_, ep)| ep.clone())
}

/// Returns `true` only when active PCM still reaches `VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK`
/// after the worker's `ISimpleAudioVolume::SetMute(TRUE)` silences its dry hardware output.
#[allow(dead_code)]
pub(crate) fn evaluate_pre_mute_loopback_probe(pre_mute_peak: f32, post_mute_peak: f32) -> bool {
    pre_mute_peak > 1e-4 && post_mute_peak > 1e-4
}

/// Converts a WASAPI PCM capture packet (`f32le` or `i16le`, 1..N channels) into stereo `f32`
/// frames inside `ring` (and `tap_buffer` when downstream `TapDspSource` is inactive). Returns peak amplitude.
#[allow(dead_code)]
pub(crate) fn push_wasapi_pcm_packet(
    data: &[u8],
    frames: usize,
    channels: usize,
    bits_per_sample: u16,
    is_float: bool,
    is_silent: bool,
    ring: &StereoTapRingBuffer,
    tap_buffer: &AudioTapBuffer,
    dsp_active: bool,
) -> f32 {
    if frames == 0 || channels == 0 {
        return 0.0;
    }

    if is_silent || data.is_empty() {
        for _ in 0..frames {
            ring.push_frame(0.0, 0.0);
            if !dsp_active {
                tap_buffer.push_mono_sample(0.0);
            }
        }
        return 0.0;
    }

    let bytes_per_sample = (bits_per_sample as usize) / 8;
    let frame_stride = channels.saturating_mul(bytes_per_sample);
    if frame_stride == 0 {
        return 0.0;
    }

    let usable_frames = frames.min(data.len() / frame_stride);
    let mut max_peak = 0.0f32;

    for f_idx in 0..usable_frames {
        let base = f_idx * frame_stride;
        let (l, r) = if is_float && bits_per_sample == 32 {
            let l_raw = f32::from_le_bytes([
                data[base],
                data[base + 1],
                data[base + 2],
                data[base + 3],
            ]);
            let r_raw = if channels >= 2 {
                f32::from_le_bytes([
                    data[base + 4],
                    data[base + 5],
                    data[base + 6],
                    data[base + 7],
                ])
            } else {
                l_raw
            };
            (
                if l_raw.is_finite() { l_raw } else { 0.0 },
                if r_raw.is_finite() { r_raw } else { 0.0 },
            )
        } else if !is_float && bits_per_sample == 16 {
            let l_raw = i16::from_le_bytes([data[base], data[base + 1]]) as f32 / 32768.0;
            let r_raw = if channels >= 2 {
                i16::from_le_bytes([data[base + 2], data[base + 3]]) as f32 / 32768.0
            } else {
                l_raw
            };
            (l_raw, r_raw)
        } else {
            (0.0, 0.0)
        };

        max_peak = max_peak.max(l.abs()).max(r.abs());
        ring.push_frame(l, r);
        if !dsp_active {
            tap_buffer.push_mono_sample(0.5 * (l + r));
        }
    }

    max_peak
}

#[cfg(target_os = "windows")]
const WAVE_FORMAT_PCM_TAG: u16 = 1;
#[cfg(target_os = "windows")]
const WAVE_FORMAT_IEEE_FLOAT_TAG: u16 = 3;
#[cfg(target_os = "windows")]
const WAVE_FORMAT_EXTENSIBLE_TAG: u16 = 0xFFFE;
#[cfg(target_os = "windows")]
const KSDATAFORMAT_SUBTYPE_IEEE_FLOAT_GUID: GUID =
    GUID::from_u128(0x00000003_0000_0010_8000_00aa00389b71);
#[cfg(target_os = "windows")]
const VT_BLOB_RAW: u16 = 65;

/// Non-dropping binary-compatible `VT_BLOB` `PROPVARIANT` wrapper pointing at stack memory.
/// Avoids `windows::core::PROPVARIANT`'s `Drop` (`PropVariantClear`) freeing stack pointers.
#[cfg(target_os = "windows")]
#[repr(C)]
struct RawBlobPropVariant {
    vt: u16,
    w_reserved1: u16,
    w_reserved2: u16,
    w_reserved3: u16,
    blob: BLOB,
}

#[cfg(target_os = "windows")]
#[repr(C)]
struct ProcessLoopbackCompletion {
    vtable: *const IActivateAudioInterfaceCompletionHandler_Vtbl,
    ref_count: AtomicU32,
    event: HANDLE,
}

#[cfg(target_os = "windows")]
static COMPLETION_HANDLER_VTBL: IActivateAudioInterfaceCompletionHandler_Vtbl =
    IActivateAudioInterfaceCompletionHandler_Vtbl {
        base__: IUnknown_Vtbl {
            QueryInterface: completion_qi,
            AddRef: completion_add_ref,
            Release: completion_release,
        },
        ActivateCompleted: completion_activate_completed,
    };

#[cfg(target_os = "windows")]
unsafe extern "system" fn completion_qi(
    this: *mut c_void,
    riid: *const GUID,
    ppv: *mut *mut c_void,
) -> HRESULT {
    if this.is_null() || ppv.is_null() {
        return E_NOINTERFACE;
    }
    if !riid.is_null() {
        let target = &*riid;
        if *target == IUnknown::IID
            || *target == IActivateAudioInterfaceCompletionHandler::IID
            || *target == IAgileObject::IID
        {
            *ppv = this;
            completion_add_ref(this);
            return S_OK;
        }
    }
    *ppv = std::ptr::null_mut();
    E_NOINTERFACE
}

#[cfg(target_os = "windows")]
unsafe extern "system" fn completion_add_ref(this: *mut c_void) -> u32 {
    let me = &*(this as *const ProcessLoopbackCompletion);
    me.ref_count.fetch_add(1, Ordering::Relaxed) + 1
}

#[cfg(target_os = "windows")]
unsafe extern "system" fn completion_release(this: *mut c_void) -> u32 {
    let me = &*(this as *const ProcessLoopbackCompletion);
    let prev = me.ref_count.fetch_sub(1, Ordering::Release);
    if prev == 1 {
        fence(Ordering::Acquire);
        drop(Box::from_raw(this as *mut ProcessLoopbackCompletion));
    }
    prev.saturating_sub(1)
}

#[cfg(target_os = "windows")]
unsafe extern "system" fn completion_activate_completed(
    this: *mut c_void,
    _op: *mut c_void,
) -> HRESULT {
    if !this.is_null() {
        let me = &*(this as *const ProcessLoopbackCompletion);
        let _ = SetEvent(me.event);
    }
    S_OK
}

#[cfg(target_os = "windows")]
struct WasapiCaptureHandle {
    _audio_client: IAudioClient,
    capture_client: IAudioCaptureClient,
    event: HANDLE,
    sample_rate: u32,
    channels: usize,
    bits_per_sample: u16,
    is_float: bool,
}

#[cfg(target_os = "windows")]
impl Drop for WasapiCaptureHandle {
    fn drop(&mut self) {
        unsafe {
            let _ = self._audio_client.Stop();
            let _ = CloseHandle(self.event);
        }
    }
}

#[cfg(target_os = "windows")]
impl WasapiCaptureHandle {
    unsafe fn drain_packets(
        &self,
        ring: &StereoTapRingBuffer,
        tap_buffer: &AudioTapBuffer,
        dsp_active: bool,
        push_to_ring: bool,
    ) -> Option<f32> {
        let mut peak_seen: Option<f32> = None;
        loop {
            let packet_frames = self.capture_client.GetNextPacketSize().unwrap_or(0);
            if packet_frames == 0 {
                break;
            }
            let mut data_ptr: *mut u8 = std::ptr::null_mut();
            let mut frames_read: u32 = 0;
            let mut flags: u32 = 0;
            if self
                .capture_client
                .GetBuffer(&mut data_ptr, &mut frames_read, &mut flags, None, None)
                .is_err()
            {
                break;
            }
            let is_silent = (flags & (AUDCLNT_BUFFERFLAGS_SILENT.0 as u32)) != 0;
            let bytes_per_frame = self.channels * ((self.bits_per_sample as usize) / 8);
            let total_bytes = (frames_read as usize).saturating_mul(bytes_per_frame);
            let slice = if data_ptr.is_null() || total_bytes == 0 {
                &[]
            } else {
                std::slice::from_raw_parts(data_ptr, total_bytes)
            };

            let peak = if push_to_ring {
                push_wasapi_pcm_packet(
                    slice,
                    frames_read as usize,
                    self.channels,
                    self.bits_per_sample,
                    self.is_float,
                    is_silent,
                    ring,
                    tap_buffer,
                    dsp_active,
                )
            } else if is_silent || slice.is_empty() {
                0.0
            } else {
                let scratch_ring = StereoTapRingBuffer::new();
                push_wasapi_pcm_packet(
                    slice,
                    frames_read as usize,
                    self.channels,
                    self.bits_per_sample,
                    self.is_float,
                    is_silent,
                    &scratch_ring,
                    tap_buffer,
                    true,
                )
            };
            peak_seen = Some(peak_seen.unwrap_or(0.0).max(peak));

            let _ = self.capture_client.ReleaseBuffer(frames_read);
        }
        peak_seen
    }
}

#[cfg(target_os = "windows")]
unsafe fn open_process_loopback_capture(target_pid: u32) -> Option<WasapiCaptureHandle> {
    if target_pid == 0 {
        return None;
    }

    let activate_event = CreateEventW(None, TRUE, FALSE, PCWSTR::null()).ok()?;
    let handler_raw = Box::into_raw(Box::new(ProcessLoopbackCompletion {
        vtable: &COMPLETION_HANDLER_VTBL,
        ref_count: AtomicU32::new(1),
        event: activate_event,
    }));
    let handler = IActivateAudioInterfaceCompletionHandler::from_raw(handler_raw as *mut c_void);

    let mut params = AUDIOCLIENT_ACTIVATION_PARAMS {
        ActivationType: AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK,
        Anonymous: AUDIOCLIENT_ACTIVATION_PARAMS_0 {
            ProcessLoopbackParams: AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS {
                TargetProcessId: target_pid,
                ProcessLoopbackMode: PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE,
            },
        },
    };
    let raw_prop = RawBlobPropVariant {
        vt: VT_BLOB_RAW,
        w_reserved1: 0,
        w_reserved2: 0,
        w_reserved3: 0,
        blob: BLOB {
            cbSize: std::mem::size_of::<AUDIOCLIENT_ACTIVATION_PARAMS>() as u32,
            pBlobData: &mut params as *mut AUDIOCLIENT_ACTIVATION_PARAMS as *mut u8,
        },
    };

    let op: IActivateAudioInterfaceAsyncOperation = match ActivateAudioInterfaceAsync(
        VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK,
        &IAudioClient::IID,
        Some(&raw_prop as *const RawBlobPropVariant as *const PROPVARIANT),
        &handler,
    ) {
        Ok(o) => o,
        Err(_) => {
            let _ = CloseHandle(activate_event);
            return None;
        }
    };

    let wait_res = WaitForSingleObject(activate_event, 4_000);
    let _ = CloseHandle(activate_event);
    if wait_res != WAIT_OBJECT_0 {
        return None;
    }

    let mut hr = S_OK;
    let mut activated: Option<IUnknown> = None;
    if op.GetActivateResult(&mut hr, &mut activated).is_err() || hr.is_err() {
        return None;
    }
    let audio_client: IAudioClient = activated?.cast().ok()?;

    let wfx = WAVEFORMATEX {
        wFormatTag: WAVE_FORMAT_IEEE_FLOAT_TAG,
        nChannels: 2,
        nSamplesPerSec: 48_000,
        nAvgBytesPerSec: 48_000 * 2 * 4,
        nBlockAlign: 8,
        wBitsPerSample: 32,
        cbSize: 0,
    };

    if audio_client
        .Initialize(
            AUDCLNT_SHAREMODE_SHARED,
            AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_EVENTCALLBACK,
            200_000,
            0,
            &wfx as *const WAVEFORMATEX,
            None,
        )
        .is_err()
    {
        return None;
    }

    let packet_event = CreateEventW(None, FALSE, FALSE, PCWSTR::null()).ok()?;
    if audio_client.SetEventHandle(packet_event).is_err() {
        let _ = CloseHandle(packet_event);
        return None;
    }
    let capture_client: IAudioCaptureClient = match audio_client.GetService() {
        Ok(c) => c,
        Err(_) => {
            let _ = CloseHandle(packet_event);
            return None;
        }
    };
    if audio_client.Start().is_err() {
        let _ = CloseHandle(packet_event);
        return None;
    }

    Some(WasapiCaptureHandle {
        _audio_client: audio_client,
        capture_client,
        event: packet_event,
        sample_rate: 48_000,
        channels: 2,
        bits_per_sample: 32,
        is_float: true,
    })
}

#[cfg(target_os = "windows")]
unsafe fn open_device_loopback_capture(endpoint_id: &str) -> Option<WasapiCaptureHandle> {
    let enumerator: IMMDeviceEnumerator =
        CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL).ok()?;
    let wide_id: Vec<u16> = endpoint_id
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect();
    let device: IMMDevice = enumerator.GetDevice(PCWSTR(wide_id.as_ptr())).ok()?;
    let audio_client: IAudioClient = device.Activate(CLSCTX_ALL, None).ok()?;
    let fmt_ptr = audio_client.GetMixFormat().ok()?;
    if fmt_ptr.is_null() {
        return None;
    }

    let fmt = &*fmt_ptr;
    let sample_rate = fmt.nSamplesPerSec.clamp(8_000, 192_000);
    let channels = (fmt.nChannels as usize).max(1);
    let bits_per_sample = fmt.wBitsPerSample;
    let is_float = if fmt.wFormatTag == WAVE_FORMAT_IEEE_FLOAT_TAG {
        true
    } else if fmt.wFormatTag == WAVE_FORMAT_EXTENSIBLE_TAG {
        let ext = &*(fmt_ptr as *const WAVEFORMATEXTENSIBLE);
        let sub_guid = std::ptr::read_unaligned(std::ptr::addr_of!(ext.SubFormat));
        sub_guid == KSDATAFORMAT_SUBTYPE_IEEE_FLOAT_GUID
    } else if fmt.wFormatTag == WAVE_FORMAT_PCM_TAG {
        false
    } else {
        false
    };

    let init_res = audio_client.Initialize(
        AUDCLNT_SHAREMODE_SHARED,
        AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_EVENTCALLBACK,
        200_000,
        0,
        fmt_ptr,
        None,
    );
    CoTaskMemFree(Some(fmt_ptr as *const c_void));
    if init_res.is_err() {
        return None;
    }

    let packet_event = CreateEventW(None, FALSE, FALSE, PCWSTR::null()).ok()?;
    if audio_client.SetEventHandle(packet_event).is_err() {
        let _ = CloseHandle(packet_event);
        return None;
    }
    let capture_client: IAudioCaptureClient = match audio_client.GetService() {
        Ok(c) => c,
        Err(_) => {
            let _ = CloseHandle(packet_event);
            return None;
        }
    };
    if audio_client.Start().is_err() {
        let _ = CloseHandle(packet_event);
        return None;
    }

    Some(WasapiCaptureHandle {
        _audio_client: audio_client,
        capture_client,
        event: packet_event,
        sample_rate,
        channels,
        bits_per_sample,
        is_float,
    })
}

#[cfg(target_os = "windows")]
unsafe fn read_pwstr_and_free(pwstr: windows::core::PWSTR) -> Option<String> {
    if pwstr.is_null() {
        return None;
    }
    let s = pwstr.to_string().ok();
    CoTaskMemFree(Some(pwstr.0 as *const c_void));
    s
}

#[cfg(target_os = "windows")]
unsafe fn enumerate_active_render_endpoints() -> Vec<WindowsRenderEndpointInfo> {
    let mut out = Vec::new();
    let Ok(enumerator): windows::core::Result<IMMDeviceEnumerator> =
        CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)
    else {
        return out;
    };

    let default_id = enumerator
        .GetDefaultAudioEndpoint(eRender, eConsole)
        .ok()
        .and_then(|dev| dev.GetId().ok().and_then(|p| read_pwstr_and_free(p)));

    let Ok(collection) = enumerator.EnumAudioEndpoints(eRender, DEVICE_STATE_ACTIVE) else {
        return out;
    };
    let count = collection.GetCount().unwrap_or(0);
    for idx in 0..count {
        let Ok(dev) = collection.Item(idx) else {
            continue;
        };
        let Some(id) = dev.GetId().ok().and_then(|p| read_pwstr_and_free(p)) else {
            continue;
        };
        let friendly_name = dev
            .OpenPropertyStore(STGM_READ)
            .ok()
            .and_then(|store| store.GetValue(&PKEY_Device_FriendlyName).ok())
            .map(|prop| prop.to_string())
            .filter(|s| !s.trim().is_empty())
            .unwrap_or_else(|| id.clone());
        let is_default = default_id.as_deref() == Some(id.as_str());
        out.push(WindowsRenderEndpointInfo {
            id,
            friendly_name,
            is_default,
        });
    }
    out
}

#[cfg(target_os = "windows")]
unsafe fn collect_process_tree_pids(root_pids: &[u32]) -> HashSet<u32> {
    let mut tree: HashSet<u32> = root_pids.iter().copied().filter(|&p| p != 0).collect();
    let Ok(snapshot) = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) else {
        return tree;
    };

    let mut pairs: Vec<(u32, u32, String)> = Vec::new();
    let mut entry: PROCESSENTRY32W = std::mem::zeroed();
    entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
    if Process32FirstW(snapshot, &mut entry).is_ok() {
        loop {
            let nul_pos = entry
                .szExeFile
                .iter()
                .position(|&c| c == 0)
                .unwrap_or(entry.szExeFile.len());
            let exe = String::from_utf16_lossy(&entry.szExeFile[..nul_pos]).to_ascii_lowercase();
            pairs.push((entry.th32ProcessID, entry.th32ParentProcessID, exe));
            if Process32NextW(snapshot, &mut entry).is_err() {
                break;
            }
        }
    }
    let _ = CloseHandle(snapshot);

    // Include future embedded Edge WebView2 (`msedgewebview2.exe`) children owned by this process
    let self_pid = std::process::id();
    for (pid, ppid, exe) in &pairs {
        if *ppid == self_pid && exe.contains("msedgewebview2") {
            tree.insert(*pid);
        }
    }

    loop {
        let mut added = false;
        for (pid, ppid, _) in &pairs {
            if tree.contains(ppid) && tree.insert(*pid) {
                added = true;
            }
        }
        if !added {
            break;
        }
    }

    tree
}

#[cfg(target_os = "windows")]
unsafe fn set_worker_sessions_muted(target_pids: &HashSet<u32>, muted: bool) -> bool {
    if target_pids.is_empty() {
        return false;
    }
    let Ok(enumerator): windows::core::Result<IMMDeviceEnumerator> =
        CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)
    else {
        return false;
    };
    let Ok(default_dev) = enumerator.GetDefaultAudioEndpoint(eRender, eConsole) else {
        return false;
    };
    let Ok(mgr) = default_dev.Activate::<IAudioSessionManager2>(CLSCTX_ALL, None) else {
        return false;
    };
    let Ok(sessions) = mgr.GetSessionEnumerator() else {
        return false;
    };
    let count = sessions.GetCount().unwrap_or(0);
    let mut touched = false;
    let mute_flag = if muted { TRUE } else { FALSE };
    for idx in 0..count {
        let Ok(ctrl) = sessions.GetSession(idx) else {
            continue;
        };
        let Ok(ctrl2) = ctrl.cast::<IAudioSessionControl2>() else {
            continue;
        };
        let Ok(pid) = ctrl2.GetProcessId() else {
            continue;
        };
        if pid != 0 && target_pids.contains(&pid) {
            if let Ok(vol) = ctrl.cast::<ISimpleAudioVolume>() {
                if vol.SetMute(mute_flag, std::ptr::null()).is_ok() {
                    touched = true;
                }
            }
        }
    }
    touched
}

#[cfg(target_os = "windows")]
fn discover_worker_root_pids() -> Vec<u32> {
    let mut roots = crate::find_windows_headless_worker_pids();
    if let Some(child_pid) = crate::sinks::apple::current_worker_child_pid() {
        if child_pid != 0 && !roots.contains(&child_pid) {
            roots.push(child_pid);
        }
    }
    roots
}

/// Manages Windows WASAPI process-loopback spectrum analysis and single-DSP routing
/// (Step 2a Win11 pre-mute loopback -> Step 2b secondary/virtual endpoint loopback ->
/// Step 2c clean spectrum-only fallback without double audio).
#[cfg(target_os = "windows")]
pub struct WindowsAudioTap {
    stop_flag: Mutex<Option<Arc<AtomicBool>>>,
}

#[cfg(target_os = "windows")]
impl Default for WindowsAudioTap {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(target_os = "windows")]
impl WindowsAudioTap {
    pub fn new() -> Self {
        Self {
            stop_flag: Mutex::new(None),
        }
    }

    pub fn start_or_refresh(&self, _volume: f64, broadcast_tx: broadcast::Sender<PlaybackEvent>) {
        if let Ok(guard) = self.stop_flag.lock() {
            if let Some(ref flag) = *guard {
                if !flag.load(Ordering::Acquire) {
                    return;
                }
            }
        }

        let stop_flag = Arc::new(AtomicBool::new(false));
        if let Ok(mut guard) = self.stop_flag.lock() {
            *guard = Some(stop_flag.clone());
        }

        let _ = std::thread::Builder::new()
            .name("simp-windows-tap".to_string())
            .spawn(move || {
                crate::prefer_efficiency_core_for_current_thread();

                let com_hr = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };
                let com_inited = com_hr == S_OK || com_hr == S_FALSE;

                let ring = Arc::new(StereoTapRingBuffer::new());
                let tap_buffer = Arc::new(AudioTapBuffer::new());
                tap_buffer.set_sample_rate(48_000);

                let mut proc_capture: Option<WasapiCaptureHandle> = None;
                let mut device_capture: Option<WasapiCaptureHandle> = None;
                let mut active_dsp_out: Option<TapDspOutput> = None;
                let mut active_root_pid: u32 = 0;
                let mut active_tree_pids: HashSet<u32> = HashSet::new();
                let mut sessions_muted = false;
                let mut pre_mute_supported: Option<bool> = None;
                let mut selected_virtual_sink: Option<WindowsRenderEndpointInfo> = None;
                let mut last_discovery_at = Instant::now() - Duration::from_secs(10);
                let mut last_virtual_scan_at = Instant::now() - Duration::from_secs(10);
                let mut last_tick_emit_at = Instant::now();
                let mut recent_peak = 0.0f32;
                let mut last_nonzero_at = Instant::now() - Duration::from_secs(30);

                while !stop_flag.load(Ordering::Acquire) {
                    let now = Instant::now();

                    if now.duration_since(last_discovery_at) >= Duration::from_millis(1200) {
                        last_discovery_at = now;
                        let roots = discover_worker_root_pids();
                        if !roots.is_empty() {
                            active_tree_pids = unsafe { collect_process_tree_pids(&roots) };
                            let candidate_pid = roots[0];
                            if proc_capture.is_none() || candidate_pid != active_root_pid {
                                proc_capture = unsafe { open_process_loopback_capture(candidate_pid) };
                                if proc_capture.is_some() {
                                    active_root_pid = candidate_pid;
                                    pre_mute_supported = None;
                                }
                            }
                        }
                    }

                    let use_device_loopback = device_capture.is_some();
                    if let Some(ref cap) = device_capture {
                        let _ = unsafe { WaitForSingleObject(cap.event, 45) };
                        let dsp_on = active_dsp_out.is_some();
                        if let Some(peak) =
                            unsafe { cap.drain_packets(&ring, &tap_buffer, dsp_on, true) }
                        {
                            recent_peak = recent_peak.max(peak);
                            if peak > 1e-5 {
                                last_nonzero_at = now;
                            }
                        }
                    }

                    if let Some(ref cap) = proc_capture {
                        let wait_ms = if use_device_loopback { 5 } else { 60 };
                        let _ = unsafe { WaitForSingleObject(cap.event, wait_ms) };
                        let dsp_on = active_dsp_out.is_some() && !use_device_loopback;
                        let push_ring = !use_device_loopback;
                        if let Some(peak) =
                            unsafe { cap.drain_packets(&ring, &tap_buffer, dsp_on, push_ring) }
                        {
                            if !use_device_loopback {
                                recent_peak = recent_peak.max(peak);
                                if peak > 1e-5 {
                                    last_nonzero_at = now;
                                }
                            }
                        }
                    } else {
                        std::thread::sleep(Duration::from_millis(80));
                    }

                    let want_dsp = !global_dsp_state().is_bypassed();
                    let audio_live = now.duration_since(last_nonzero_at) < Duration::from_secs(10);

                    if want_dsp && audio_live {
                        // Step 2a: Empirical Windows 11 pre-mute loopback spike
                        if pre_mute_supported.is_none()
                            && proc_capture.is_some()
                            && !active_tree_pids.is_empty()
                        {
                            let pre_peak = recent_peak;
                            let muted_any = unsafe { set_worker_sessions_muted(&active_tree_pids, true) };
                            if muted_any {
                                std::thread::sleep(Duration::from_millis(45));
                                if let Some(ref cap) = proc_capture {
                                    let _ = unsafe {
                                        cap.drain_packets(&ring, &tap_buffer, false, false)
                                    };
                                }
                                let mut post_peak = 0.0f32;
                                let probe_start = Instant::now();
                                while probe_start.elapsed() < Duration::from_millis(180)
                                    && !stop_flag.load(Ordering::Acquire)
                                {
                                    if let Some(ref cap) = proc_capture {
                                        let _ = unsafe { WaitForSingleObject(cap.event, 45) };
                                        if let Some(p) = unsafe {
                                            cap.drain_packets(&ring, &tap_buffer, false, false)
                                        } {
                                            post_peak = post_peak.max(p);
                                        }
                                    }
                                }
                                let works = evaluate_pre_mute_loopback_probe(pre_peak, post_peak);
                                pre_mute_supported = Some(works);
                                if works {
                                    sessions_muted = true;
                                    let sr = proc_capture
                                        .as_ref()
                                        .map(|c| c.sample_rate)
                                        .unwrap_or(48_000);
                                    if let Some(out) =
                                        TapDspOutput::open(ring.clone(), tap_buffer.clone(), sr)
                                    {
                                        active_dsp_out = Some(out);
                                        set_global_tap_status(AudioTapStatusSnapshot {
                                            platform: "windows".to_string(),
                                            mode: "windows_process_loopback_dsp".to_string(),
                                            dsp_active: true,
                                            spectrum_active: true,
                                            worker_sink_label: None,
                                            detail: "Windows Process Loopback pre-mute DSP active (zero double audio)."
                                                .to_string(),
                                        });
                                    }
                                } else {
                                    // Post-mute engine: immediately unmute dry worker session and move to Step 2b
                                    unsafe { set_worker_sessions_muted(&active_tree_pids, false) };
                                    sessions_muted = false;
                                }
                            } else {
                                pre_mute_supported = Some(false);
                            }
                        } else if pre_mute_supported == Some(true)
                            && active_dsp_out.is_none()
                            && proc_capture.is_some()
                        {
                            if !sessions_muted && !active_tree_pids.is_empty() {
                                sessions_muted =
                                    unsafe { set_worker_sessions_muted(&active_tree_pids, true) };
                            }
                            if sessions_muted {
                                let sr = proc_capture
                                    .as_ref()
                                    .map(|c| c.sample_rate)
                                    .unwrap_or(48_000);
                                if let Some(out) =
                                    TapDspOutput::open(ring.clone(), tap_buffer.clone(), sr)
                                {
                                    active_dsp_out = Some(out);
                                    set_global_tap_status(AudioTapStatusSnapshot {
                                        platform: "windows".to_string(),
                                        mode: "windows_process_loopback_dsp".to_string(),
                                        dsp_active: true,
                                        spectrum_active: true,
                                        worker_sink_label: None,
                                        detail: "Windows Process Loopback pre-mute DSP active (zero double audio)."
                                            .to_string(),
                                    });
                                }
                            }
                        } else if pre_mute_supported == Some(false) && active_dsp_out.is_none() {
                            // Step 2b: Virtual/secondary endpoint loopback routing
                            if now.duration_since(last_virtual_scan_at) >= Duration::from_secs(4) {
                                last_virtual_scan_at = now;
                                let endpoints = unsafe { enumerate_active_render_endpoints() };
                                let override_env = std::env::var("IMP_WINDOWS_TAP_SINK").ok();
                                selected_virtual_sink = select_windows_virtual_loopback_sink(
                                    &endpoints,
                                    override_env.as_deref(),
                                );
                            }
                            if let Some(ref ep) = selected_virtual_sink {
                                if device_capture.is_none() {
                                    device_capture = unsafe { open_device_loopback_capture(&ep.id) };
                                }
                                if let Some(ref cap) = device_capture {
                                    if let Some(out) = TapDspOutput::open(
                                        ring.clone(),
                                        tap_buffer.clone(),
                                        cap.sample_rate,
                                    ) {
                                        active_dsp_out = Some(out);
                                        set_global_tap_status(AudioTapStatusSnapshot {
                                            platform: "windows".to_string(),
                                            mode: "windows_virtual_sink_dsp".to_string(),
                                            dsp_active: true,
                                            spectrum_active: true,
                                            worker_sink_label: Some(ep.friendly_name.clone()),
                                            detail: format!(
                                                "10-Band EQ + Vocal DSP active via virtual endpoint ({}).",
                                                ep.friendly_name
                                            ),
                                        });
                                    }
                                }
                            } else {
                                // Step 2c: Spectrum-only (zero double audio)
                                set_global_tap_status(AudioTapStatusSnapshot {
                                    platform: "windows".to_string(),
                                    mode: "windows_spectrum_only".to_string(),
                                    dsp_active: false,
                                    spectrum_active: true,
                                    worker_sink_label: None,
                                    detail: "Windows muted DRM sessions before Process Loopback. Spectrum works live; for EQ on Apple DRM streams install VB-Audio Virtual Cable (or set IMP_WINDOWS_TAP_SINK), or play Uploaded/Matched DRM-free tracks via native Rust audio."
                                        .to_string(),
                                });
                            }
                        }
                    } else if !want_dsp {
                        if let Some(out) = active_dsp_out.take() {
                            out.stop();
                        }
                        if device_capture.is_some() {
                            device_capture = None;
                        }
                        if sessions_muted {
                            unsafe { set_worker_sessions_muted(&active_tree_pids, false) };
                            sessions_muted = false;
                        }
                        if proc_capture.is_some() && audio_live {
                            set_global_tap_status(AudioTapStatusSnapshot {
                                platform: "windows".to_string(),
                                mode: "windows_spectrum_only".to_string(),
                                dsp_active: false,
                                spectrum_active: true,
                                worker_sink_label: None,
                                detail: "Windows Process Loopback spectrum analyzer active (EQ bypassed)."
                                    .to_string(),
                            });
                        }
                    }

                    if audio_live && now.duration_since(last_tick_emit_at) >= Duration::from_millis(80)
                    {
                        last_tick_emit_at = now;
                        recent_peak = 0.0;
                        let (rms, peak, onset, bands) = tap_buffer.compute_spectrum_tick();
                        if rms > 0.0005 || peak > 0.0005 {
                            let _ = broadcast_tx.send(PlaybackEvent::AudioSpectrumTick {
                                rms,
                                peak,
                                onset,
                                bands,
                            });
                        }
                    }
                }

                if let Some(out) = active_dsp_out.take() {
                    out.stop();
                }
                if sessions_muted && !active_tree_pids.is_empty() {
                    unsafe { set_worker_sessions_muted(&active_tree_pids, false) };
                }
                reset_global_tap_status();
                if com_inited {
                    unsafe { CoUninitialize() };
                }
            });
    }

    pub fn set_volume(&self, _volume: f64) {}

    pub fn stop(&self) {
        if let Ok(mut guard) = self.stop_flag.lock() {
            if let Some(flag) = guard.take() {
                flag.store(true, Ordering::Release);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_select_windows_virtual_loopback_sink() {
        let endpoints = vec![
            WindowsRenderEndpointInfo {
                id: "dev-speakers".to_string(),
                friendly_name: "Realtek(R) Speakers".to_string(),
                is_default: true,
            },
            WindowsRenderEndpointInfo {
                id: "dev-cable".to_string(),
                friendly_name: "CABLE Input (VB-Audio Virtual Cable)".to_string(),
                is_default: false,
            },
            WindowsRenderEndpointInfo {
                id: "dev-hdmi".to_string(),
                friendly_name: "DisplayPort Audio Monitor".to_string(),
                is_default: false,
            },
        ];

        let picked = select_windows_virtual_loopback_sink(&endpoints, None)
            .expect("should select virtual cable");
        assert_eq!(picked.id, "dev-cable");

        let overridden = select_windows_virtual_loopback_sink(&endpoints, Some("DisplayPort"))
            .expect("should honor env override for non-default endpoint");
        assert_eq!(overridden.id, "dev-hdmi");

        // Never pick the default endpoint even if named in override
        assert!(select_windows_virtual_loopback_sink(&endpoints, Some("Realtek")).is_none());
    }

    #[test]
    fn test_evaluate_pre_mute_loopback_probe() {
        assert!(evaluate_pre_mute_loopback_probe(0.25, 0.22));
        assert!(!evaluate_pre_mute_loopback_probe(0.25, 0.0));
        assert!(!evaluate_pre_mute_loopback_probe(0.0, 0.25));
    }

    #[test]
    fn test_push_wasapi_pcm_packet_float_and_i16() {
        let ring = StereoTapRingBuffer::new();
        let tap_buf = AudioTapBuffer::new();
        tap_buf.set_sample_rate(48_000);

        let mut float_pkt = Vec::new();
        float_pkt.extend_from_slice(&0.5f32.to_le_bytes());
        float_pkt.extend_from_slice(&(-0.25f32).to_le_bytes());
        let peak_f =
            push_wasapi_pcm_packet(&float_pkt, 1, 2, 32, true, false, &ring, &tap_buf, false);
        assert!((peak_f - 0.5).abs() < 1e-5);

        let mut i16_pkt = Vec::new();
        i16_pkt.extend_from_slice(&16384i16.to_le_bytes());
        i16_pkt.extend_from_slice(&(-16384i16).to_le_bytes());
        let peak_i =
            push_wasapi_pcm_packet(&i16_pkt, 1, 2, 16, false, false, &ring, &tap_buf, false);
        assert!((peak_i - 0.5).abs() < 1e-3);

        let peak_s =
            push_wasapi_pcm_packet(&float_pkt, 2, 2, 32, true, true, &ring, &tap_buf, false);
        assert_eq!(peak_s, 0.0);
        assert_eq!(ring.available_frames(), 4);
    }
}
