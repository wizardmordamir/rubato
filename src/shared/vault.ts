/**
 * Vault — an encrypted, master-password-gated credential store (the single-user
 * sibling of cursedalchemy's `/vault`). Everything but id/timestamps is encrypted
 * at rest on the server under a SERVER-held key and is only returned after the
 * vault is unlocked with the master password. Mirrors the `/api/vault` payloads.
 */

/** An extra labelled field on a vault item; mark `secret` to mask + protect it. */
export interface VaultField {
  label: string;
  value: string;
  secret?: boolean;
}

/** A decrypted vault item, as returned once the vault is unlocked. */
export interface VaultItem {
  id: string;
  title: string;
  link?: string;
  username?: string;
  description?: string;
  notes?: string;
  password?: string;
  fields: VaultField[];
  createdAt: number;
  updatedAt: number;
}

/** The editable subset used to create/update an item (everything encrypted). */
export interface VaultItemInput {
  title: string;
  link?: string;
  username?: string;
  description?: string;
  notes?: string;
  password?: string;
  fields?: VaultField[];
}

/** The locked-view status: whether a master password is set + item count. */
export interface VaultStatus {
  hasMaster: boolean;
  itemCount: number;
}
