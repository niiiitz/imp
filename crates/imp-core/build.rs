fn main() {
    println!("cargo:rerun-if-env-changed=SIMP_EMBEDDED_APPLE_DEV_TOKEN");
    println!("cargo:rerun-if-env-changed=SIMP_EMBEDDED_APPLE_USER_TOKEN");
    println!("cargo:rerun-if-env-changed=SIMP_EMBEDDED_SOUNDCLOUD_CLIENT_ID");
    println!("cargo:rerun-if-env-changed=IMP_EMBEDDED_ACOUSTID_API_KEY");
}
