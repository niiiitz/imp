#![allow(unexpected_cfgs)]

use crate::dsp::global_dsp_state;
use crate::sinks::tap_dsp::{
    reset_global_tap_status, set_global_tap_status, AudioTapStatusSnapshot, StereoTapRingBuffer,
    TapDspOutput,
};
#[cfg(test)]
use crate::sinks::tap_dsp::TapDspSource;
use crate::viz::AudioTapBuffer;
use core_foundation::array::CFArray;
use core_foundation::base::TCFType;
use core_foundation::dictionary::CFDictionary;
use core_foundation::number::CFNumber;
use core_foundation::string::CFString;
use objc::runtime::{Class, Object};
use objc::{class, msg_send, sel, sel_impl};
use imp_protocol::PlaybackEvent;
use std::collections::{HashMap, HashSet};
use std::ffi::{c_char, c_void, CString};
use std::ptr;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
#[cfg(test)]
use rodio::Source;
use tokio::sync::broadcast;

type Id = *mut Object;
const NIL: Id = ptr::null_mut();
const YES_BOOL: i8 = 1;

type AudioObjectID = u32;
type OSStatus = i32;
type AudioDeviceIOProcID = *mut c_void;

const K_AUDIO_OBJECT_UNKNOWN: AudioObjectID = 0;
const K_AUDIO_OBJECT_SYSTEM_OBJECT: AudioObjectID = 1;
const K_AUDIO_OBJECT_PROPERTY_ELEMENT_MAIN: u32 = 0;
const K_AUDIO_OBJECT_PROPERTY_SCOPE_GLOBAL: u32 = u32::from_be_bytes(*b"glob");
const K_AUDIO_OBJECT_PROPERTY_SCOPE_INPUT: u32 = u32::from_be_bytes(*b"inpt");

const K_AUDIO_HARDWARE_PROPERTY_PROCESS_OBJECT_LIST: u32 = u32::from_be_bytes(*b"prs#");
const K_AUDIO_HARDWARE_PROPERTY_DEFAULT_OUTPUT_DEVICE: u32 = u32::from_be_bytes(*b"dOut");
const K_AUDIO_PROCESS_PROPERTY_PID: u32 = u32::from_be_bytes(*b"ppid");
const K_AUDIO_PROCESS_PROPERTY_BUNDLE_ID: u32 = u32::from_be_bytes(*b"pbid");
const K_AUDIO_PROCESS_PROPERTY_IS_RUNNING_OUTPUT: u32 = u32::from_be_bytes(*b"piro");
const K_AUDIO_TAP_PROPERTY_UID: u32 = u32::from_be_bytes(*b"tuid");
const K_AUDIO_TAP_PROPERTY_DESCRIPTION: u32 = u32::from_be_bytes(*b"tdsc");
const K_AUDIO_TAP_PROPERTY_FORMAT: u32 = u32::from_be_bytes(*b"tfmt");
const K_AUDIO_DEVICE_PROPERTY_DEVICE_UID: u32 = u32::from_be_bytes(*b"uid ");
const K_AUDIO_DEVICE_PROPERTY_STREAM_FORMAT: u32 = u32::from_be_bytes(*b"sfmt");

const CATAP_UNMUTED: isize = 0;
const CATAP_MUTED_WHEN_TAPPED: isize = 2;

const PROC_PIDT_SHORTBSDINFO: libc::c_int = 13;
const MAXCOMLEN: usize = 16;

#[repr(C)]
#[derive(Clone, Copy)]
struct AudioObjectPropertyAddress {
    m_selector: u32,
    m_scope: u32,
    m_element: u32,
}

#[repr(C)]
#[derive(Clone, Copy, Default)]
struct AudioStreamBasicDescription {
    m_sample_rate: f64,
    m_format_id: u32,
    m_format_flags: u32,
    m_bytes_per_packet: u32,
    m_frames_per_packet: u32,
    m_bytes_per_frame: u32,
    m_channels_per_frame: u32,
    m_bits_per_channel: u32,
    m_reserved: u32,
}

#[repr(C)]
struct AudioBuffer {
    m_number_channels: u32,
    m_data_byte_size: u32,
    m_data: *mut c_void,
}

#[repr(C)]
struct AudioBufferList {
    m_number_buffers: u32,
    m_buffers: [AudioBuffer; 1],
}

#[repr(C)]
#[derive(Clone, Copy)]
struct ProcBsdShortInfo {
    pbsi_pid: u32,
    pbsi_ppid: u32,
    pbsi_pgid: u32,
    pbsi_status: u32,
    pbsi_comm: [c_char; MAXCOMLEN],
    pbsi_flags: u32,
    pbsi_uid: u32,
    pbsi_gid: u32,
    pbsi_ruid: u32,
    pbsi_rgid: u32,
    pbsi_svuid: u32,
    pbsi_svgid: u32,
    pbsi_rfu: u32,
}

type CreateProcessTapFn = unsafe extern "C" fn(Id, *mut AudioObjectID) -> OSStatus;
type DestroyProcessTapFn = unsafe extern "C" fn(AudioObjectID) -> OSStatus;

type AudioDeviceIOProc = unsafe extern "C" fn(
    in_device: AudioObjectID,
    in_now: *const c_void,
    in_input_data: *const AudioBufferList,
    in_input_time: *const c_void,
    out_output_data: *mut AudioBufferList,
    in_output_time: *const c_void,
    in_client_data: *mut c_void,
) -> OSStatus;

#[link(name = "CoreAudio", kind = "framework")]
extern "C" {
    fn AudioObjectGetPropertyDataSize(
        in_object_id: AudioObjectID,
        in_address: *const AudioObjectPropertyAddress,
        in_qualifier_data_size: u32,
        in_qualifier_data: *const c_void,
        out_data_size: *mut u32,
    ) -> OSStatus;

    fn AudioObjectGetPropertyData(
        in_object_id: AudioObjectID,
        in_address: *const AudioObjectPropertyAddress,
        in_qualifier_data_size: u32,
        in_qualifier_data: *const c_void,
        io_data_size: *mut u32,
        out_data: *mut c_void,
    ) -> OSStatus;

    fn AudioObjectSetPropertyData(
        in_object_id: AudioObjectID,
        in_address: *const AudioObjectPropertyAddress,
        in_qualifier_data_size: u32,
        in_qualifier_data: *const c_void,
        in_data_size: u32,
        in_data: *const c_void,
    ) -> OSStatus;

    fn AudioHardwareCreateAggregateDevice(
        in_description: *const c_void,
        out_device_id: *mut AudioObjectID,
    ) -> OSStatus;

    fn AudioHardwareDestroyAggregateDevice(in_device_id: AudioObjectID) -> OSStatus;

    fn AudioDeviceCreateIOProcID(
        in_device: AudioObjectID,
        in_proc: AudioDeviceIOProc,
        in_client_data: *mut c_void,
        out_io_proc_id: *mut AudioDeviceIOProcID,
    ) -> OSStatus;

    fn AudioDeviceDestroyIOProcID(
        in_device: AudioObjectID,
        in_io_proc_id: AudioDeviceIOProcID,
    ) -> OSStatus;

    fn AudioDeviceStart(in_device: AudioObjectID, in_proc_id: AudioDeviceIOProcID) -> OSStatus;
    fn AudioDeviceStop(in_device: AudioObjectID, in_proc_id: AudioDeviceIOProcID) -> OSStatus;
}

#[link(name = "Foundation", kind = "framework")]
extern "C" {}

extern "C" {
    fn proc_pidinfo(
        pid: libc::c_int,
        flavor: libc::c_int,
        arg: u64,
        buffer: *mut c_void,
        buffersize: libc::c_int,
    ) -> libc::c_int;

    fn proc_pidpath(
        pid: libc::c_int,
        buffer: *mut c_void,
        buffersize: u32,
    ) -> libc::c_int;
}

struct TapCallbackContext {
    ring: Arc<StereoTapRingBuffer>,
    tap_buffer: Arc<AudioTapBuffer>,
    dsp_active: Arc<AtomicBool>,
    confirmed_nonzero: Arc<AtomicBool>,
    nonzero_ticks: Arc<AtomicU64>,
    sample_rate: Arc<AtomicU32>,
}

#[inline]
fn process_pcm_frame(ctx: &TapCallbackContext, left: f32, right: f32, any_nonzero: &mut bool) {
    let l = if left.is_finite() { left } else { 0.0 };
    let r = if right.is_finite() { right } else { 0.0 };
    if l.abs() > 1e-6 || r.abs() > 1e-6 {
        *any_nonzero = true;
    }
    ctx.ring.push_frame(l, r);
    if !ctx.dsp_active.load(Ordering::Relaxed) {
        ctx.tap_buffer.push_mono_sample(0.5 * (l + r));
    }
}

unsafe extern "C" fn coreaudio_tap_ioproc(
    _in_device: AudioObjectID,
    _in_now: *const c_void,
    in_input_data: *const AudioBufferList,
    _in_input_time: *const c_void,
    _out_output_data: *mut AudioBufferList,
    _in_output_time: *const c_void,
    in_client_data: *mut c_void,
) -> OSStatus {
    if in_input_data.is_null() || in_client_data.is_null() {
        return 0;
    }
    let ctx = &*(in_client_data as *const TapCallbackContext);
    ctx.tap_buffer
        .set_sample_rate(ctx.sample_rate.load(Ordering::Relaxed));

    let abl = &*in_input_data;
    let num_bufs = abl.m_number_buffers as usize;
    if num_bufs == 0 {
        return 0;
    }

    let bufs = std::slice::from_raw_parts(abl.m_buffers.as_ptr(), num_bufs);
    let mut any_nonzero = false;

    if num_bufs >= 2 && !bufs[0].m_data.is_null() && !bufs[1].m_data.is_null() {
        // Planar / non-interleaved stereo (Buffer 0 = L, Buffer 1 = R)
        let l_cnt = (bufs[0].m_data_byte_size as usize) / std::mem::size_of::<f32>();
        let r_cnt = (bufs[1].m_data_byte_size as usize) / std::mem::size_of::<f32>();
        let frames = l_cnt.min(r_cnt);
        let l_slice = std::slice::from_raw_parts(bufs[0].m_data as *const f32, frames);
        let r_slice = std::slice::from_raw_parts(bufs[1].m_data as *const f32, frames);
        for i in 0..frames {
            process_pcm_frame(ctx, l_slice[i], r_slice[i], &mut any_nonzero);
        }
    } else if !bufs[0].m_data.is_null() {
        let ch = (bufs[0].m_number_channels as usize).max(1);
        let total_floats = (bufs[0].m_data_byte_size as usize) / std::mem::size_of::<f32>();
        let floats = std::slice::from_raw_parts(bufs[0].m_data as *const f32, total_floats);
        if ch >= 2 {
            let frames = total_floats / ch;
            for f in 0..frames {
                let base = f * ch;
                process_pcm_frame(ctx, floats[base], floats[base + 1], &mut any_nonzero);
            }
        } else {
            for &s in floats {
                process_pcm_frame(ctx, s, s, &mut any_nonzero);
            }
        }
    }

    if any_nonzero {
        ctx.confirmed_nonzero.store(true, Ordering::Release);
        ctx.nonzero_ticks.fetch_add(1, Ordering::Relaxed);
    }
    0
}

unsafe fn query_process_parent_pid(pid: u32) -> Option<u32> {
    let mut info: ProcBsdShortInfo = std::mem::zeroed();
    let ret = proc_pidinfo(
        pid as libc::c_int,
        PROC_PIDT_SHORTBSDINFO,
        0,
        &mut info as *mut ProcBsdShortInfo as *mut c_void,
        std::mem::size_of::<ProcBsdShortInfo>() as libc::c_int,
    );
    if ret == std::mem::size_of::<ProcBsdShortInfo>() as libc::c_int {
        Some(info.pbsi_ppid)
    } else {
        None
    }
}

/// Checks whether `target_pid` is a strict child/descendant of `ancestor_pid` using a PID->PPID map.
pub fn is_descendant_of_pid(target_pid: u32, ancestor_pid: u32, ppid_map: &HashMap<u32, u32>) -> bool {
    if target_pid == 0 || ancestor_pid == 0 || target_pid == ancestor_pid {
        return false;
    }
    let mut cur = target_pid;
    let mut visited = HashSet::new();
    for _ in 0..16 {
        if !visited.insert(cur) {
            break;
        }
        let Some(&ppid) = ppid_map.get(&cur) else {
            break;
        };
        if ppid == ancestor_pid {
            return true;
        }
        if ppid == 0 || ppid == cur {
            break;
        }
        cur = ppid;
    }
    false
}

unsafe fn query_cf_string_property(obj_id: AudioObjectID, selector: u32) -> Option<String> {
    let addr = AudioObjectPropertyAddress {
        m_selector: selector,
        m_scope: K_AUDIO_OBJECT_PROPERTY_SCOPE_GLOBAL,
        m_element: K_AUDIO_OBJECT_PROPERTY_ELEMENT_MAIN,
    };
    let mut cf_str_ref: *const c_void = ptr::null();
    let mut size = std::mem::size_of::<*const c_void>() as u32;
    let status = AudioObjectGetPropertyData(
        obj_id,
        &addr,
        0,
        ptr::null(),
        &mut size,
        &mut cf_str_ref as *mut *const c_void as *mut c_void,
    );
    if status != 0 || cf_str_ref.is_null() {
        return None;
    }
    let wrapped = CFString::wrap_under_create_rule(cf_str_ref as core_foundation::string::CFStringRef);
    Some(wrapped.to_string())
}

unsafe fn query_default_output_device_uid() -> Option<String> {
    let addr = AudioObjectPropertyAddress {
        m_selector: K_AUDIO_HARDWARE_PROPERTY_DEFAULT_OUTPUT_DEVICE,
        m_scope: K_AUDIO_OBJECT_PROPERTY_SCOPE_GLOBAL,
        m_element: K_AUDIO_OBJECT_PROPERTY_ELEMENT_MAIN,
    };
    let mut dev_id: AudioObjectID = K_AUDIO_OBJECT_UNKNOWN;
    let mut size = std::mem::size_of::<AudioObjectID>() as u32;
    let status = AudioObjectGetPropertyData(
        K_AUDIO_OBJECT_SYSTEM_OBJECT,
        &addr,
        0,
        ptr::null(),
        &mut size,
        &mut dev_id as *mut AudioObjectID as *mut c_void,
    );
    if status != 0 || dev_id == K_AUDIO_OBJECT_UNKNOWN {
        return None;
    }
    query_cf_string_property(dev_id, K_AUDIO_DEVICE_PROPERTY_DEVICE_UID)
}

unsafe fn resolve_process_tap_fns() -> Option<(CreateProcessTapFn, DestroyProcessTapFn)> {
    let create_name = CString::new("AudioHardwareCreateProcessTap").ok()?;
    let destroy_name = CString::new("AudioHardwareDestroyProcessTap").ok()?;
    let create_ptr = libc::dlsym(libc::RTLD_DEFAULT, create_name.as_ptr());
    let destroy_ptr = libc::dlsym(libc::RTLD_DEFAULT, destroy_name.as_ptr());
    if create_ptr.is_null() || destroy_ptr.is_null() {
        return None;
    }
    Some((
        std::mem::transmute::<*mut c_void, CreateProcessTapFn>(create_ptr),
        std::mem::transmute::<*mut c_void, DestroyProcessTapFn>(destroy_ptr),
    ))
}

unsafe fn query_process_path(pid: u32) -> String {
    let mut buf = [0u8; 4096];
    let ret = proc_pidpath(
        pid as libc::c_int,
        buf.as_mut_ptr() as *mut c_void,
        buf.len() as u32,
    );
    if ret > 0 {
        let len = (ret as usize).min(buf.len());
        String::from_utf8_lossy(&buf[..len]).into_owned()
    } else {
        String::new()
    }
}

/// Identifies WebKit XPC / browser audio output helper processes while excluding SIMP CLI
/// binaries and editor/IDE helpers so CoreAudio Process Taps never capture IDE or self audio.
pub fn is_browser_or_webkit_audio_process(bundle_id: &str, proc_path: &str) -> bool {
    let b = bundle_id.trim().to_ascii_lowercase();
    let p = proc_path.trim().to_ascii_lowercase();
    if b.is_empty() && p.is_empty() {
        return false;
    }

    // Explicitly exclude IDEs, editors, terminals, and SIMP CLI/daemon binaries.
    if b.contains("antigravity")
        || p.contains("antigravity")
        || b.contains("vscode")
        || p.contains("visual studio code")
        || b.contains("cursor")
        || p.contains("/cursor.app/")
        || b.contains("todesktop")
        || p.ends_with("/simp")
    {
        return false;
    }

    b == "com.apple.webkit.gpu"
        || b == "com.apple.webkit.webcontent"
        || b.starts_with("com.apple.webkit.")
        || p.contains("com.apple.webkit.gpu")
        || p.contains("com.apple.webkit.webcontent")
        || b.starts_with("com.apple.safari")
        || p.contains("/safari.app/")
        || b.starts_with("com.brave.browser")
        || p.contains("brave browser")
        || b.starts_with("com.google.chrome")
        || p.contains("google chrome")
        || b.starts_with("org.chromium.chromium")
        || p.contains("chromium")
        || b.starts_with("com.microsoft.edgemac")
        || p.contains("microsoft edge")
        || b.starts_with("org.mozilla.firefox")
        || p.contains("/firefox.app/")
        || p.ends_with("/plugin-container")
        || b.starts_with("company.thebrowser.browser")
        || p.contains("/arc.app/")
        || b.starts_with("com.vivaldi.vivaldi")
        || p.contains("/vivaldi.app/")
        || b.starts_with("com.operasoftware.opera")
        || p.contains("/opera.app/")
}

unsafe fn find_webkit_audio_process_objects(my_pid: u32) -> Vec<AudioObjectID> {
    let addr = AudioObjectPropertyAddress {
        m_selector: K_AUDIO_HARDWARE_PROPERTY_PROCESS_OBJECT_LIST,
        m_scope: K_AUDIO_OBJECT_PROPERTY_SCOPE_GLOBAL,
        m_element: K_AUDIO_OBJECT_PROPERTY_ELEMENT_MAIN,
    };
    let mut byte_size: u32 = 0;
    if AudioObjectGetPropertyDataSize(K_AUDIO_OBJECT_SYSTEM_OBJECT, &addr, 0, ptr::null(), &mut byte_size) != 0
        || byte_size < std::mem::size_of::<AudioObjectID>() as u32
    {
        return Vec::new();
    }
    let count = (byte_size as usize) / std::mem::size_of::<AudioObjectID>();
    let mut proc_objs = vec![0u32; count];
    if AudioObjectGetPropertyData(
        K_AUDIO_OBJECT_SYSTEM_OBJECT,
        &addr,
        0,
        ptr::null(),
        &mut byte_size,
        proc_objs.as_mut_ptr() as *mut c_void,
    ) != 0
    {
        return Vec::new();
    }

    let mut candidates: Vec<(AudioObjectID, bool)> = Vec::new();
    let mut ppid_map: HashMap<u32, u32> = HashMap::new();

    for obj_id in proc_objs {
        let pid_addr = AudioObjectPropertyAddress {
            m_selector: K_AUDIO_PROCESS_PROPERTY_PID,
            m_scope: K_AUDIO_OBJECT_PROPERTY_SCOPE_GLOBAL,
            m_element: K_AUDIO_OBJECT_PROPERTY_ELEMENT_MAIN,
        };
        let mut pid_val: libc::pid_t = 0;
        let mut pid_sz = std::mem::size_of::<libc::pid_t>() as u32;
        if AudioObjectGetPropertyData(
            obj_id,
            &pid_addr,
            0,
            ptr::null(),
            &mut pid_sz,
            &mut pid_val as *mut libc::pid_t as *mut c_void,
        ) != 0
            || pid_val <= 0
        {
            continue;
        }
        let pid = pid_val as u32;
        if pid == my_pid {
            // Never tap SIMP's own Rodio process to prevent feedback loops when DSP is enabled.
            continue;
        }

        // Populate a small ancestor chain for `pid`.
        let mut walker = pid;
        for _ in 0..8 {
            if ppid_map.contains_key(&walker) {
                break;
            }
            if let Some(parent) = query_process_parent_pid(walker) {
                ppid_map.insert(walker, parent);
                if parent == 0 || parent == 1 || parent == walker {
                    break;
                }
                walker = parent;
            } else {
                break;
            }
        }

        let bundle_id = query_cf_string_property(obj_id, K_AUDIO_PROCESS_PROPERTY_BUNDLE_ID)
            .unwrap_or_default();
        let proc_path = query_process_path(pid);
        let is_descendant = is_descendant_of_pid(pid, my_pid, &ppid_map);
        if !is_descendant && !is_browser_or_webkit_audio_process(&bundle_id, &proc_path) {
            continue;
        }

        let run_addr = AudioObjectPropertyAddress {
            m_selector: K_AUDIO_PROCESS_PROPERTY_IS_RUNNING_OUTPUT,
            m_scope: K_AUDIO_OBJECT_PROPERTY_SCOPE_GLOBAL,
            m_element: K_AUDIO_OBJECT_PROPERTY_ELEMENT_MAIN,
        };
        let mut running_out: u32 = 0;
        let mut run_sz = std::mem::size_of::<u32>() as u32;
        let _ = AudioObjectGetPropertyData(
            obj_id,
            &run_addr,
            0,
            ptr::null(),
            &mut run_sz,
            &mut running_out as *mut u32 as *mut c_void,
        );
        candidates.push((obj_id, running_out != 0));
    }

    let mut matched: Vec<AudioObjectID> = candidates
        .iter()
        .filter(|(_, running)| *running)
        .map(|(obj_id, _)| *obj_id)
        .collect();
    if matched.is_empty() {
        matched = candidates.into_iter().map(|(obj_id, _)| obj_id).collect();
    }
    matched.sort_unstable();
    matched.dedup();
    matched
}

struct ActiveTapHandle {
    tap_id: AudioObjectID,
    tap_desc: Id,
    agg_device_id: AudioObjectID,
    ioproc_id: AudioDeviceIOProcID,
    ctx_ptr: *mut TapCallbackContext,
    destroy_tap_fn: DestroyProcessTapFn,
    mute_behavior: isize,
}

unsafe impl Send for ActiveTapHandle {}

impl ActiveTapHandle {
    unsafe fn set_mute_behavior(&mut self, behavior: isize) -> bool {
        if self.mute_behavior == behavior {
            return true;
        }
        let prev = self.mute_behavior;
        let pool: Id = msg_send![class!(NSAutoreleasePool), new];
        let _: () = msg_send![self.tap_desc, setMuteBehavior: behavior];
        let addr = AudioObjectPropertyAddress {
            m_selector: K_AUDIO_TAP_PROPERTY_DESCRIPTION,
            m_scope: K_AUDIO_OBJECT_PROPERTY_SCOPE_GLOBAL,
            m_element: K_AUDIO_OBJECT_PROPERTY_ELEMENT_MAIN,
        };
        let status = AudioObjectSetPropertyData(
            self.tap_id,
            &addr,
            0,
            ptr::null(),
            std::mem::size_of::<Id>() as u32,
            &self.tap_desc as *const Id as *const c_void,
        );
        if status == 0 {
            let mut verify_ptr: Id = NIL;
            let mut verify_sz = std::mem::size_of::<Id>() as u32;
            let verify_status = AudioObjectGetPropertyData(
                self.tap_id,
                &addr,
                0,
                ptr::null(),
                &mut verify_sz,
                &mut verify_ptr as *mut Id as *mut c_void,
            );
            let verified = if verify_status == 0 && verify_ptr != NIL {
                let actual: isize = msg_send![verify_ptr, isMuted];
                let _: () = msg_send![verify_ptr, release];
                actual == behavior
            } else {
                false
            };
            let _: () = msg_send![pool, drain];
            if verified {
                self.mute_behavior = behavior;
                return true;
            }
        } else {
            let _: () = msg_send![self.tap_desc, setMuteBehavior: prev];
            let _: () = msg_send![pool, drain];
        }
        false
    }

    unsafe fn teardown(self) {
        if self.agg_device_id != K_AUDIO_OBJECT_UNKNOWN {
            if !self.ioproc_id.is_null() {
                let _ = AudioDeviceStop(self.agg_device_id, self.ioproc_id);
                let _ = AudioDeviceDestroyIOProcID(self.agg_device_id, self.ioproc_id);
            }
            let _ = AudioHardwareDestroyAggregateDevice(self.agg_device_id);
        }
        if self.tap_id != K_AUDIO_OBJECT_UNKNOWN {
            let _ = (self.destroy_tap_fn)(self.tap_id);
        }
        if self.tap_desc != NIL {
            let _: () = msg_send![self.tap_desc, release];
        }
        if !self.ctx_ptr.is_null() {
            drop(Box::from_raw(self.ctx_ptr));
        }
    }
}

unsafe fn create_webkit_process_tap(
    proc_obj_ids: &[AudioObjectID],
    ring: Arc<StereoTapRingBuffer>,
    tap_buffer: Arc<AudioTapBuffer>,
    dsp_active: Arc<AtomicBool>,
    confirmed_nonzero: Arc<AtomicBool>,
    nonzero_ticks: Arc<AtomicU64>,
    sample_rate: Arc<AtomicU32>,
    initial_mute_behavior: isize,
) -> Option<ActiveTapHandle> {
    if proc_obj_ids.is_empty() {
        return None;
    }
    let (create_tap_fn, destroy_tap_fn) = resolve_process_tap_fns()?;
    let Some(tap_cls) = Class::get("CATapDescription") else {
        return None;
    };

    let pool: Id = msg_send![class!(NSAutoreleasePool), new];
    let ns_arr: Id = msg_send![class!(NSMutableArray), arrayWithCapacity: proc_obj_ids.len()];
    for &obj_id in proc_obj_ids {
        let num: Id = msg_send![class!(NSNumber), numberWithUnsignedInt: obj_id];
        let _: () = msg_send![ns_arr, addObject: num];
    }

    let tap_desc: Id = msg_send![tap_cls, alloc];
    let tap_desc: Id = msg_send![tap_desc, initStereoMixdownOfProcesses: ns_arr];
    if tap_desc == NIL {
        let _: () = msg_send![pool, drain];
        return None;
    }

    let tap_name_cstr = CString::new("SIMP Apple Music Process Tap").unwrap();
    let tap_name_ns: Id = msg_send![class!(NSString), stringWithUTF8String: tap_name_cstr.as_ptr()];
    let _: () = msg_send![tap_desc, setName: tap_name_ns];
    let _: () = msg_send![tap_desc, setPrivate: YES_BOOL];
    let _: () = msg_send![tap_desc, setMuteBehavior: initial_mute_behavior];

    let mut tap_id: AudioObjectID = K_AUDIO_OBJECT_UNKNOWN;
    let tap_status = (create_tap_fn)(tap_desc, &mut tap_id);
    if tap_status != 0 || tap_id == K_AUDIO_OBJECT_UNKNOWN {
        let _: () = msg_send![tap_desc, release];
        let _: () = msg_send![pool, drain];
        return None;
    }

    // Read assigned Tap UID (`CFString`) for Aggregate Device sub-tap list.
    let Some(tap_uid) = query_cf_string_property(tap_id, K_AUDIO_TAP_PROPERTY_UID) else {
        let _ = (destroy_tap_fn)(tap_id);
        let _: () = msg_send![tap_desc, release];
        let _: () = msg_send![pool, drain];
        return None;
    };

    // Query stream sample rate from the newly created tap object.
    let fmt_addr = AudioObjectPropertyAddress {
        m_selector: K_AUDIO_TAP_PROPERTY_FORMAT,
        m_scope: K_AUDIO_OBJECT_PROPERTY_SCOPE_GLOBAL,
        m_element: K_AUDIO_OBJECT_PROPERTY_ELEMENT_MAIN,
    };
    let mut asbd = AudioStreamBasicDescription::default();
    let mut fmt_sz = std::mem::size_of::<AudioStreamBasicDescription>() as u32;
    if AudioObjectGetPropertyData(
        tap_id,
        &fmt_addr,
        0,
        ptr::null(),
        &mut fmt_sz,
        &mut asbd as *mut AudioStreamBasicDescription as *mut c_void,
    ) == 0
        && asbd.m_sample_rate >= 8_000.0
    {
        sample_rate.store(asbd.m_sample_rate.round() as u32, Ordering::Relaxed);
    }

    let sub_tap = CFDictionary::from_CFType_pairs(&[
        (
            CFString::from_static_string("uid"),
            CFString::new(&tap_uid).as_CFType(),
        ),
        (
            CFString::from_static_string("drift"),
            CFNumber::from(1i32).as_CFType(),
        ),
    ]);
    let tap_list = CFArray::from_CFTypes(&[sub_tap.as_CFType()]);
    let agg_uid = format!("org.simp.player.webkittap.{}.{}", libc::getpid(), tap_id);
    let mut agg_pairs = vec![
        (
            CFString::from_static_string("uid"),
            CFString::new(&agg_uid).as_CFType(),
        ),
        (
            CFString::from_static_string("name"),
            CFString::from_static_string("SIMP WebKit Audio Tap").as_CFType(),
        ),
        (
            CFString::from_static_string("private"),
            CFNumber::from(1i32).as_CFType(),
        ),
        (
            CFString::from_static_string("tapautostart"),
            CFNumber::from(1i32).as_CFType(),
        ),
        (
            CFString::from_static_string("taps"),
            tap_list.as_CFType(),
        ),
    ];
    if let Some(def_dev_uid) = query_default_output_device_uid() {
        let sub_dev = CFDictionary::from_CFType_pairs(&[(
            CFString::from_static_string("uid"),
            CFString::new(&def_dev_uid).as_CFType(),
        )]);
        let sub_devs = CFArray::from_CFTypes(&[sub_dev.as_CFType()]);
        agg_pairs.push((
            CFString::from_static_string("master"),
            CFString::new(&def_dev_uid).as_CFType(),
        ));
        agg_pairs.push((
            CFString::from_static_string("subdevices"),
            sub_devs.as_CFType(),
        ));
    }
    let agg_desc = CFDictionary::from_CFType_pairs(&agg_pairs);

    let mut agg_device_id: AudioObjectID = K_AUDIO_OBJECT_UNKNOWN;
    let agg_status = AudioHardwareCreateAggregateDevice(
        agg_desc.as_concrete_TypeRef() as *const c_void,
        &mut agg_device_id,
    );
    if agg_status != 0 || agg_device_id == K_AUDIO_OBJECT_UNKNOWN {
        let _ = (destroy_tap_fn)(tap_id);
        let _: () = msg_send![tap_desc, release];
        let _: () = msg_send![pool, drain];
        return None;
    }

    // Refine sample rate from Aggregate Device's input stream format if reported.
    let dev_fmt_addr = AudioObjectPropertyAddress {
        m_selector: K_AUDIO_DEVICE_PROPERTY_STREAM_FORMAT,
        m_scope: K_AUDIO_OBJECT_PROPERTY_SCOPE_INPUT,
        m_element: K_AUDIO_OBJECT_PROPERTY_ELEMENT_MAIN,
    };
    let mut dev_asbd = AudioStreamBasicDescription::default();
    let mut dev_fmt_sz = std::mem::size_of::<AudioStreamBasicDescription>() as u32;
    if AudioObjectGetPropertyData(
        agg_device_id,
        &dev_fmt_addr,
        0,
        ptr::null(),
        &mut dev_fmt_sz,
        &mut dev_asbd as *mut AudioStreamBasicDescription as *mut c_void,
    ) == 0
        && dev_asbd.m_sample_rate >= 8_000.0
    {
        sample_rate.store(dev_asbd.m_sample_rate.round() as u32, Ordering::Relaxed);
    }

    let ctx_box = Box::new(TapCallbackContext {
        ring,
        tap_buffer,
        dsp_active,
        confirmed_nonzero,
        nonzero_ticks,
        sample_rate,
    });
    let ctx_ptr = Box::into_raw(ctx_box);

    let mut ioproc_id: AudioDeviceIOProcID = ptr::null_mut();
    let proc_status = AudioDeviceCreateIOProcID(
        agg_device_id,
        coreaudio_tap_ioproc,
        ctx_ptr as *mut c_void,
        &mut ioproc_id,
    );
    if proc_status != 0 || ioproc_id.is_null() {
        let _ = AudioHardwareDestroyAggregateDevice(agg_device_id);
        let _ = (destroy_tap_fn)(tap_id);
        let _: () = msg_send![tap_desc, release];
        drop(Box::from_raw(ctx_ptr));
        let _: () = msg_send![pool, drain];
        return None;
    }

    let start_status = AudioDeviceStart(agg_device_id, ioproc_id);
    if start_status != 0 {
        let _ = AudioDeviceDestroyIOProcID(agg_device_id, ioproc_id);
        let _ = AudioHardwareDestroyAggregateDevice(agg_device_id);
        let _ = (destroy_tap_fn)(tap_id);
        let _: () = msg_send![tap_desc, release];
        drop(Box::from_raw(ctx_ptr));
        let _: () = msg_send![pool, drain];
        return None;
    }

    let _: () = msg_send![pool, drain];
    Some(ActiveTapHandle {
        tap_id,
        tap_desc,
        agg_device_id,
        ioproc_id,
        ctx_ptr,
        destroy_tap_fn,
        mute_behavior: initial_mute_behavior,
    })
}

struct TapSharedState {
    ring: Arc<StereoTapRingBuffer>,
    tap_buffer: Arc<AudioTapBuffer>,
    dsp_active: Arc<AtomicBool>,
    confirmed_nonzero: Arc<AtomicBool>,
    nonzero_ticks: Arc<AtomicU64>,
    sample_rate: Arc<AtomicU32>,
}

/// Switches `active_tap` to `target_mute`, tearing down and recreating the CoreAudio
/// process tap when the OS rejects live `kAudioTapPropertyDescription` updates.
unsafe fn switch_or_recreate_tap_mute(
    active_tap: &mut Option<ActiveTapHandle>,
    active_proc_objs: &mut Vec<AudioObjectID>,
    my_pid: u32,
    shared: &TapSharedState,
    target_mute: isize,
) -> bool {
    let Some(ref mut tap) = *active_tap else {
        return false;
    };
    if tap.set_mute_behavior(target_mute) {
        return true;
    }
    let fresh_targets = find_webkit_audio_process_objects(my_pid);
    let targets = if fresh_targets.is_empty() {
        active_proc_objs.clone()
    } else {
        fresh_targets
    };
    if let Some(old_tap) = active_tap.take() {
        old_tap.teardown();
    }
    *active_tap = create_webkit_process_tap(
        &targets,
        shared.ring.clone(),
        shared.tap_buffer.clone(),
        shared.dsp_active.clone(),
        shared.confirmed_nonzero.clone(),
        shared.nonzero_ticks.clone(),
        shared.sample_rate.clone(),
        target_mute,
    );
    if active_tap.is_some() {
        *active_proc_objs = targets;
        true
    } else {
        active_proc_objs.clear();
        false
    }
}

/// Manages macOS `CATapDescription` capture of `WKWebView` Apple Music audio, routing live PCM
/// into `AudioTapBuffer` (16-band spectrum + onset detector) and switching cleanly to
/// `CATapMutedWhenTapped` + `StreamDspProcessor` + `rodio::Sink` when EQ / Vocal DSP is active.
pub struct MacOsWebKitAudioTap {
    stop_flag: Mutex<Option<Arc<AtomicBool>>>,
}

impl Default for MacOsWebKitAudioTap {
    fn default() -> Self {
        Self::new()
    }
}

impl MacOsWebKitAudioTap {
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
            .name("simp-macos-tap".to_string())
            .spawn(move || {
                crate::prefer_efficiency_core_for_current_thread();

                let shared = TapSharedState {
                    ring: Arc::new(StereoTapRingBuffer::new()),
                    tap_buffer: Arc::new(AudioTapBuffer::new()),
                    dsp_active: Arc::new(AtomicBool::new(false)),
                    confirmed_nonzero: Arc::new(AtomicBool::new(false)),
                    nonzero_ticks: Arc::new(AtomicU64::new(0)),
                    sample_rate: Arc::new(AtomicU32::new(48_000)),
                };

                let mut active_tap: Option<ActiveTapHandle> = None;
                let mut active_proc_objs: Vec<AudioObjectID> = Vec::new();
                let mut active_dsp_out: Option<TapDspOutput> = None;
                let mut last_discovery_at = Instant::now() - Duration::from_secs(10);
                let mut last_nonzero_seen_tick = 0u64;
                let mut last_nonzero_instant = Instant::now();
                let mut logged_tap_active = false;

                while !stop_flag.load(Ordering::Acquire) {
                    let now = Instant::now();
                    let my_pid = unsafe { libc::getpid() } as u32;
                    let cur_tick = shared.nonzero_ticks.load(Ordering::Relaxed);
                    if cur_tick != last_nonzero_seen_tick {
                        last_nonzero_seen_tick = cur_tick;
                        last_nonzero_instant = now;
                    }

                    // Discover/attach CoreAudio process tap initially, when a new browser/WebKit
                    // audio helper appears, or when an existing tap has not yet produced non-zero PCM.
                    let discovery_due = if active_tap.is_none() {
                        now.duration_since(last_discovery_at) >= Duration::from_millis(600)
                    } else {
                        now.duration_since(last_discovery_at) >= Duration::from_millis(1500)
                    };
                    if discovery_due {
                        last_discovery_at = now;
                        let proc_objs = unsafe { find_webkit_audio_process_objects(my_pid) };
                        let has_nonzero_now = shared.confirmed_nonzero.load(Ordering::Acquire);
                        let missing_candidate =
                            proc_objs.iter().any(|id| !active_proc_objs.contains(id));
                        let should_replace = !proc_objs.is_empty()
                            && (active_tap.is_none()
                                || missing_candidate
                                || (!has_nonzero_now && proc_objs != active_proc_objs));
                        if should_replace {
                            let initial_mute = if active_dsp_out.is_some() {
                                CATAP_MUTED_WHEN_TAPPED
                            } else {
                                CATAP_UNMUTED
                            };
                            if let Some(old_tap) = active_tap.take() {
                                unsafe {
                                    old_tap.teardown();
                                }
                            }
                            if !has_nonzero_now {
                                shared.confirmed_nonzero.store(false, Ordering::Release);
                            }
                            active_tap = unsafe {
                                create_webkit_process_tap(
                                    &proc_objs,
                                    shared.ring.clone(),
                                    shared.tap_buffer.clone(),
                                    shared.dsp_active.clone(),
                                    shared.confirmed_nonzero.clone(),
                                    shared.nonzero_ticks.clone(),
                                    shared.sample_rate.clone(),
                                    initial_mute,
                                )
                            };
                            if active_tap.is_some() {
                                active_proc_objs = proc_objs;
                                if !logged_tap_active {
                                    logged_tap_active = true;
                                    tracing::info!(
                                        "Attached macOS CoreAudio Process Tap to {} WebKit/browser audio process(es)",
                                        active_proc_objs.len()
                                    );
                                }
                            } else {
                                active_proc_objs.clear();
                            }
                        }
                    }

                    let has_nonzero = shared.confirmed_nonzero.load(Ordering::Acquire);
                    let recently_nonzero =
                        now.duration_since(last_nonzero_instant) < Duration::from_secs(15);
                    let want_dsp = !global_dsp_state().is_bypassed() && has_nonzero && recently_nonzero;

                    if want_dsp && active_dsp_out.is_none() && active_tap.is_some() {
                        let switched = unsafe {
                            switch_or_recreate_tap_mute(
                                &mut active_tap,
                                &mut active_proc_objs,
                                my_pid,
                                &shared,
                                CATAP_MUTED_WHEN_TAPPED,
                            )
                        };
                        if switched {
                            last_nonzero_instant = Instant::now();
                            let sr = shared.sample_rate.load(Ordering::Relaxed);
                            if let Some(out) = TapDspOutput::open(
                                shared.ring.clone(),
                                shared.tap_buffer.clone(),
                                sr,
                            ) {
                                shared.dsp_active.store(true, Ordering::Release);
                                active_dsp_out = Some(out);
                                set_global_tap_status(AudioTapStatusSnapshot {
                                    platform: "macos".to_string(),
                                    mode: "macos_coreaudio_tap_dsp".to_string(),
                                    dsp_active: true,
                                    spectrum_active: true,
                                    worker_sink_label: None,
                                    detail: "CoreAudio process tap muted dry output; 10-Band EQ + Vocal DSP active."
                                        .to_string(),
                                });
                            } else {
                                unsafe {
                                    let _ = switch_or_recreate_tap_mute(
                                        &mut active_tap,
                                        &mut active_proc_objs,
                                        my_pid,
                                        &shared,
                                        CATAP_UNMUTED,
                                    );
                                }
                            }
                        }
                    } else if !want_dsp && active_dsp_out.is_some() {
                        shared.dsp_active.store(false, Ordering::Release);
                        if let Some(out) = active_dsp_out.take() {
                            out.stop();
                        }
                        unsafe {
                            let _ = switch_or_recreate_tap_mute(
                                &mut active_tap,
                                &mut active_proc_objs,
                                my_pid,
                                &shared,
                                CATAP_UNMUTED,
                            );
                        }
                        set_global_tap_status(AudioTapStatusSnapshot {
                            platform: "macos".to_string(),
                            mode: "macos_coreaudio_tap_spectrum".to_string(),
                            dsp_active: false,
                            spectrum_active: true,
                            worker_sink_label: None,
                            detail: "CoreAudio process tap spectrum analyzer active (EQ bypassed)."
                                .to_string(),
                        });
                    } else if active_tap.is_some() && active_dsp_out.is_none() && has_nonzero {
                        set_global_tap_status(AudioTapStatusSnapshot {
                            platform: "macos".to_string(),
                            mode: "macos_coreaudio_tap_spectrum".to_string(),
                            dsp_active: false,
                            spectrum_active: true,
                            worker_sink_label: None,
                            detail: "CoreAudio process tap spectrum analyzer active (EQ bypassed)."
                                .to_string(),
                        });
                    }

                    if has_nonzero && recently_nonzero {
                        let (rms, peak, onset, bands) = shared.tap_buffer.compute_spectrum_tick();
                        if rms > 0.0005 || peak > 0.0005 {
                            let _ = broadcast_tx.send(PlaybackEvent::AudioSpectrumTick {
                                rms,
                                peak,
                                onset,
                                bands,
                            });
                        }
                    }

                    std::thread::sleep(Duration::from_millis(80));
                }

                shared.dsp_active.store(false, Ordering::Release);
                if let Some(out) = active_dsp_out.take() {
                    out.stop();
                }
                if let Some(tap) = active_tap.take() {
                    unsafe {
                        tap.teardown();
                    }
                }
                reset_global_tap_status();
            });
    }

    pub fn set_volume(&self, _volume: f64) {
        // Output loudness is already controlled by WebKit MusicKit volume (`perceptual_cubic_gain`)
        // before entering the process tap, so the tapped DSP rodio output stays at unity gain (1.0).
    }

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
    fn test_is_descendant_of_pid_walks_process_tree_safely() {
        let mut map = HashMap::new();
        map.insert(100, 1);
        map.insert(200, 100);
        map.insert(300, 200);
        // Self-cycle guard
        map.insert(400, 401);
        map.insert(401, 400);

        assert!(!is_descendant_of_pid(100, 100, &map));
        assert!(is_descendant_of_pid(200, 100, &map));
        assert!(is_descendant_of_pid(300, 100, &map));
        assert!(!is_descendant_of_pid(400, 100, &map));
        assert!(!is_descendant_of_pid(999, 100, &map));
    }

    #[test]
    fn test_stereo_tap_ring_and_dsp_source_updates_tap_buffer() {
        let ring = Arc::new(StereoTapRingBuffer::new());
        let tap_buf = Arc::new(AudioTapBuffer::new());
        let running = Arc::new(AtomicBool::new(true));

        for i in 0..256 {
            let phase = (i as f32) * 0.2;
            let sample = phase.sin() * 0.5;
            ring.push_frame(sample, -sample * 0.5);
        }

        let mut src = TapDspSource::new(ring, tap_buf.clone(), 48_000, running.clone());
        assert_eq!(src.channels(), 2);
        assert_eq!(src.sample_rate(), 48_000);

        let mut out_samples = Vec::new();
        for _ in 0..512 {
            out_samples.push(src.next().expect("stereo sample"));
        }
        assert_eq!(out_samples.len(), 512);

        let (rms, peak, _onset, _bands) = tap_buf.compute_spectrum_tick();
        assert!(rms > 0.01 && peak > 0.05, "expected non-zero spectrum from tap source");

        running.store(false, Ordering::Release);
        assert!(src.next().is_none());
    }

    #[test]
    fn test_is_browser_or_webkit_audio_process_matches_browsers_and_excludes_ides() {
        assert!(is_browser_or_webkit_audio_process(
            "com.apple.WebKit.GPU",
            "/System/Library/Frameworks/WebKit.framework/Versions/A/XPCServices/com.apple.WebKit.GPU.xpc/Contents/MacOS/com.apple.WebKit.GPU"
        ));
        assert!(is_browser_or_webkit_audio_process(
            "com.brave.Browser.helper",
            "/Applications/Brave Browser.app/Contents/Frameworks/Brave Browser Framework.framework/Helpers/Brave Browser Helper (Aperitif)"
        ));
        assert!(is_browser_or_webkit_audio_process(
            "com.google.Chrome.helper",
            "/Applications/Google Chrome.app/Contents/Frameworks/Google Chrome Framework.framework/Helpers/Google Chrome Helper"
        ));
        assert!(is_browser_or_webkit_audio_process(
            "",
            "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser"
        ));
        assert!(!is_browser_or_webkit_audio_process(
            "com.google.antigravity-ide.helper",
            "/Applications/Antigravity IDE.app/Contents/Frameworks/Antigravity IDE Helper.app/Contents/MacOS/Antigravity IDE Helper"
        ));
        assert!(!is_browser_or_webkit_audio_process(
            "",
            "/Users/example/workspace/simp/target/debug/simp"
        ));
    }
}
