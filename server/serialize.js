// The only places where database rows become API responses. Keeping this in
// one file makes it easy to check that nothing private (PIN hash, sessions)
// ever leaves the server.

export function serializeMe(u) {
  return {
    id: u.id,
    phone: u.phone,
    name: u.name,
    about: u.about,
    avatarVersion: u.avatar_version,
    keyVersion: u.key_version,
    hasPin: Boolean(u.pin_hash),
  };
}

export function publicProfile(u) {
  return {
    id: u.id,
    phone: u.phone,
    name: u.name,
    about: u.about,
    avatarVersion: u.avatar_version,
    encPub: u.enc_pub,
    sigPub: u.sig_pub,
    keyVersion: u.key_version,
  };
}

/** Columns needed by publicProfile, for SELECT lists. */
export const PROFILE_COLUMNS = 'u.id, u.phone, u.name, u.about, u.avatar_version, u.enc_pub, u.sig_pub, u.key_version';
