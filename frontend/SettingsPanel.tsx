import { DialogControlsSection, DialogControlsSectionHeader, Field, SliderField, Toggle } from 'millennium';
import { useEffect, useState } from 'react';
import { Messages, useMessages } from './i18n';
import { setSetting, Settings, useSettings } from './settings';
import * as steam from './steam';

type BooleanKey = { [K in keyof Settings]: Settings[K] extends boolean ? K : never }[keyof Settings];

const ToggleSetting = ({ settingKey, label, description, disabled }: { settingKey: BooleanKey; label: string; description: string; disabled?: boolean }) => {
	const settings = useSettings();
	return (
		<Field label={label} description={description} disabled={disabled}>
			<Toggle value={settings[settingKey]} disabled={disabled} onChange={(value: boolean) => setSetting(settingKey, value)} />
		</Field>
	);
};

/** Steam's own "Dock chats to the friends list" setting, mirrored for convenience. */
const DockedChatsToggle = ({ text }: { text: Messages }) => {
	const [enabled, setEnabled] = useState(steam.isDockedChatsEnabled());
	useEffect(() => {
		const timer = window.setInterval(() => setEnabled(steam.isDockedChatsEnabled()), 1000);
		return () => window.clearInterval(timer);
	}, []);
	return (
		<Field label={text.dockedChats} description={text.dockedChatsDesc}>
			<Toggle
				value={enabled}
				onChange={(value: boolean) => {
					steam.setDockedChatsEnabled(value);
					setEnabled(steam.isDockedChatsEnabled());
				}}
			/>
		</Field>
	);
};

export const SettingsPanel = () => {
	const settings = useSettings();
	const text = useMessages();
	const flyoutOff = !settings.flyoutEnabled;

	return (
		<>
			<DialogControlsSection>
				<DialogControlsSectionHeader>{text.sectionFlyout}</DialogControlsSectionHeader>
				<ToggleSetting settingKey="flyoutEnabled" label={text.flyoutEnabled} description={text.flyoutEnabledDesc} />
				<ToggleSetting
					settingKey="flyoutCloseOnOutsideClick"
					label={text.flyoutCloseOnOutsideClick}
					description={text.flyoutCloseOnOutsideClickDesc}
					disabled={flyoutOff}
				/>
				<SliderField
					label={text.flyoutFriendsWidth}
					value={settings.flyoutFriendsWidth}
					min={240}
					max={600}
					step={10}
					showValue
					valueSuffix=" px"
					resetValue={320}
					disabled={flyoutOff}
					onChange={(value: number) => setSetting('flyoutFriendsWidth', value)}
				/>
				<SliderField
					label={text.flyoutChatWidth}
					value={settings.flyoutChatWidth}
					min={360}
					max={1200}
					step={10}
					showValue
					valueSuffix=" px"
					resetValue={640}
					disabled={flyoutOff}
					onChange={(value: number) => setSetting('flyoutChatWidth', value)}
				/>
				<SliderField
					label={text.flyoutHeight}
					description={text.flyoutHeightDesc}
					value={settings.flyoutHeightPercent}
					min={30}
					max={100}
					step={5}
					showValue
					valueSuffix=" %"
					resetValue={75}
					disabled={flyoutOff}
					onChange={(value: number) => setSetting('flyoutHeightPercent', value)}
				/>
			</DialogControlsSection>

			<DialogControlsSection>
				<DialogControlsSectionHeader>{text.sectionFriendsList}</DialogControlsSectionHeader>
				<ToggleSetting settingKey="sortOfflineByRecent" label={text.sortOfflineByRecent} description={text.sortOfflineByRecentDesc} />
			</DialogControlsSection>

			<DialogControlsSection>
				<DialogControlsSectionHeader>{text.sectionChats}</DialogControlsSectionHeader>
				<ToggleSetting settingKey="unreadIndicator" label={text.unreadIndicator} description={text.unreadIndicatorDesc} />
				<ToggleSetting settingKey="chatTabSelectorOnlyForManyChats" label={text.chatTabSelector} description={text.chatTabSelectorDesc} />
			</DialogControlsSection>

			<DialogControlsSection>
				<DialogControlsSectionHeader>{text.sectionDockedChats}</DialogControlsSectionHeader>
				<DockedChatsToggle text={text} />
				<ToggleSetting settingKey="hideEmptyDockedChat" label={text.hideEmptyDockedChat} description={text.hideEmptyDockedChatDesc} />
			</DialogControlsSection>

			<DialogControlsSection>
				<DialogControlsSectionHeader>{text.sectionTroubleshooting}</DialogControlsSectionHeader>
				<ToggleSetting settingKey="debugLogging" label={text.debugLogging} description={text.debugLoggingDesc} />
			</DialogControlsSection>
		</>
	);
};
