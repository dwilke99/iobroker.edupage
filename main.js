'use strict';

/*
 * Created with @iobroker/create-adapter v3.1.2
 */

// The adapter-core module gives you access to the core ioBroker functions
// you need to create an adapter
const utils = require('@iobroker/adapter-core');

// Load your modules here, e.g.:
// const fs = require('fs');
const EdupageAPI = require('edupage-api');

class Edupage extends utils.Adapter {
	/**
	 * @param {Partial<utils.AdapterOptions>} [options] - Adapter options
	 */
	constructor(options) {
		super({
			...options,
			name: 'edupage',
		});
		this.on('ready', this.onReady.bind(this));
		this.on('stateChange', this.onStateChange.bind(this));
		// this.on('objectChange', this.onObjectChange.bind(this));
		// this.on('message', this.onMessage.bind(this));
		this.on('unload', this.onUnload.bind(this));
		this.edupageClient = null;
		this.pollInterval = null;
	}

	/**
	 * Is called when databases are connected and adapter received configuration.
	 */
	async onReady() {
		// Initialize your adapter here

		// The adapters config (in the instance object everything under the attribute "native") is accessible via
		// this.config:
		const username = this.config.username;
		const password = this.config.password;
		const schoolSubdomain = this.config.schoolSubdomain;
		const interval = this.config.interval || 30;

		// Validate configuration
		if (!username || !password || !schoolSubdomain) {
			this.log.error('Missing required configuration: username, password, or schoolSubdomain');
			await this.setState('info.connection', { val: false, ack: true });
			return;
		}

		this.log.info(`Connecting to Edupage with subdomain: ${schoolSubdomain}`);

		try {
			// Initialize Edupage client
			this.edupageClient = new EdupageAPI(schoolSubdomain);

			// Login to Edupage
			await this.edupageClient.login(username, password);
			this.log.info('Successfully logged in to Edupage');

			// Set connection status
			await this.setState('info.connection', { val: true, ack: true });

			// Perform initial sync
			await this.syncData();

			// Set up polling interval (convert minutes to milliseconds)
			const intervalMs = interval * 60 * 1000;
			this.pollInterval = setInterval(async () => {
				await this.syncData();
			}, intervalMs);

			this.log.info(`Polling interval set to ${interval} minutes`);
		} catch (error) {
			this.log.error(`Failed to connect to Edupage: ${error.message}`);
			await this.setState('info.connection', { val: false, ack: true });
		}
	}

	/**
	 * Sync data from Edupage API
	 */
	async syncData() {
		if (!this.edupageClient) {
			this.log.warn('Edupage client not initialized');
			return;
		}

		try {
			this.log.debug('Fetching data from Edupage...');

			// Fetch homeworks and notifications
			const homeworks = await this.edupageClient.getHomeworks();
			const notifications = await this.edupageClient.getNotifications();

			// Save homeworks data
			const homeworkJson = JSON.stringify(homeworks);
			await this.setState('data.homework_json', { val: homeworkJson, ack: true });
			await this.setState('data.homework_count', { val: homeworks.length, ack: true });

			// Save notifications data
			const notificationsJson = JSON.stringify(notifications);
			await this.setState('data.notifications_json', { val: notificationsJson, ack: true });
			await this.setState('data.notifications_count', { val: notifications.length, ack: true });

			this.log.debug(`Synced ${homeworks.length} homeworks and ${notifications.length} notifications`);

			// Update connection status
			await this.setState('info.connection', { val: true, ack: true });
		} catch (error) {
			this.log.error(`Error syncing data from Edupage: ${error.message}`);
			await this.setState('info.connection', { val: false, ack: true });
		}
	}

	/**
	 * Is called when adapter shuts down - callback has to be called under any circumstances!
	 *
	 * @param {() => void} callback - Callback function
	 */
	onUnload(callback) {
		try {
			// Here you must clear all timeouts or intervals that may still be active
			if (this.pollInterval) {
				clearInterval(this.pollInterval);
				this.pollInterval = null;
			}

			callback();
		} catch (error) {
			this.log.error(`Error during unloading: ${error.message}`);
			callback();
		}
	}

	// If you need to react to object changes, uncomment the following block and the corresponding line in the constructor.
	// You also need to subscribe to the objects with `this.subscribeObjects`, similar to `this.subscribeStates`.
	// /**
	//  * Is called if a subscribed object changes
	//  * @param {string} id
	//  * @param {ioBroker.Object | null | undefined} obj
	//  */
	// onObjectChange(id, obj) {
	// 	if (obj) {
	// 		// The object was changed
	// 		this.log.info(`object ${id} changed: ${JSON.stringify(obj)}`);
	// 	} else {
	// 		// The object was deleted
	// 		this.log.info(`object ${id} deleted`);
	// 	}
	// }

	/**
	 * Is called if a subscribed state changes
	 *
	 * @param {string} id - State ID
	 * @param {ioBroker.State | null | undefined} state - State object
	 */
	onStateChange(id, state) {
		if (state) {
			// The state was changed
			this.log.info(`state ${id} changed: ${state.val} (ack = ${state.ack})`);

			if (state.ack === false) {
				// This is a command from the user (e.g., from the UI or other adapter)
				// and should be processed by the adapter
				this.log.info(`User command received for ${id}: ${state.val}`);

				// TODO: Add your control logic here
			}
		} else {
			// The object was deleted or the state value has expired
			this.log.info(`state ${id} deleted`);
		}
	}
	// If you need to accept messages in your adapter, uncomment the following block and the corresponding line in the constructor.
	// /**
	//  * Some message was sent to this instance over message box. Used by email, pushover, text2speech, ...
	//  * Using this method requires "common.messagebox" property to be set to true in io-package.json
	//  * @param {ioBroker.Message} obj
	//  */
	// onMessage(obj) {
	// 	if (typeof obj === 'object' && obj.message) {
	// 		if (obj.command === 'send') {
	// 			// e.g. send email or pushover or whatever
	// 			this.log.info('send command');

	// 			// Send response in callback if required
	// 			if (obj.callback) this.sendTo(obj.from, obj.command, 'Message received', obj.callback);
	// 		}
	// 	}
	// }
}

if (require.main !== module) {
	// Export the constructor in compact mode
	/**
	 * @param {Partial<utils.AdapterOptions>} [options] - Adapter options
	 */
	module.exports = options => new Edupage(options);
} else {
	// otherwise start the instance directly
	new Edupage();
}
