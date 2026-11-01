import { loadSettingsSnapshot } from '../../../lib/storage.ts';
import { toWuPageSettings } from '../../../webpage/wupage-settings.ts';

export async function getSettings() { return toWuPageSettings(await loadSettingsSnapshot()); }
