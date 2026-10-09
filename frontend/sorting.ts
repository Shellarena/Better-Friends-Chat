import { warn } from './log';
import { getSettings, onSettingsChanged } from './settings';

// Friend group components report themselves when they are created (patch #1), so a
// changed setting also re-sorts lists that are already open, like the flyout.
const friendGroups = new Set<WeakRef<any>>();

/** Patch #1: initial sort order for a new friend group. */
export function onFriendGroupCreated(group: any): boolean {
	if (group) {
		// Forget groups that are gone: friends lists create new ones as long as Steam runs.
		for (const ref of friendGroups) if (!ref.deref()) friendGroups.delete(ref);
		friendGroups.add(new WeakRef(group));
	}
	return getSettings().sortOfflineByRecent;
}

function applyToFriendGroups(sortByRecent: boolean) {
	for (const ref of friendGroups) {
		const group = ref.deref();
		if (!group || group.updater?.isMounted?.(group) === false) {
			friendGroups.delete(ref);
			continue;
		}
		try {
			group.setState({ bSortOfflineByRecent: sortByRecent });
		} catch (e) {
			warn('could not re-sort a friend group', e);
		}
	}
}

export function initSorting() {
	onSettingsChanged((settings, key) => {
		if (key === 'sortOfflineByRecent' || key === null) applyToFriendGroups(settings.sortOfflineByRecent);
	});
}
