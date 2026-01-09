'use strict';

/*
 * Created with @iobroker/create-adapter v3.1.2
 */

// The adapter-core module gives you access to the core ioBroker functions
// you need to create an adapter
const utils = require('@iobroker/adapter-core');

// Load your modules here, e.g.:
// const fs = require('fs');
const { Edupage: EdupageClient } = require('edupage-api');

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
			// Initialize Edupage client (constructor takes no parameters)
			this.edupageClient = new EdupageClient();

			// Login to Edupage (login automatically calls refresh())
			// The subdomain is determined from the login process
			await this.edupageClient.login(username, password);
			this.log.info('Successfully logged in to Edupage');

			// Set connection status
			await this.setState('info.connection', { val: true, ack: true });

			// Perform initial sync (data is already loaded from login, but we'll sync it)
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

			// Refresh timeline data to get latest homeworks and notifications
			await this.edupageClient.refreshTimeline();

			// Access homeworks and timeline (notifications) as properties
			const homeworks = this.edupageClient.homeworks || [];
			const timeline = this.edupageClient.timeline || [];

			// Convert objects to plain JSON for storage
			const homeworksData = homeworks.map(hw => {
				// Extract relevant data from Homework objects
				return {
					id: hw.id,
					subject: hw.subject?.name || null,
					title: hw.title || null,
					description: hw.details || null,
					dueDate: hw.toDate || null,
					assignedDate: hw.fromDate || null,
					isDone: hw.isFinished || false,
					teacher: hw.owner?.name || null
				};
			});

			const timelineData = timeline.map(msg => {
				// Extract relevant data from Message objects
				return {
					id: msg.id,
					type: msg.type || null,
					text: msg.text || null,
					date: msg.date || null,
					author: msg.author?.name || null
				};
			});

			// Split homeworks into pending and completed
			const pendingHomeworks = homeworksData.filter(hw => !hw.isDone);
			const completedHomeworks = homeworksData.filter(hw => hw.isDone);

			// Filter notifications by today's date
			const today = new Date();
			today.setHours(0, 0, 0, 0);
			const todayNotifications = timelineData.filter(msg => {
				if (!msg.date) return false;
				const msgDate = new Date(msg.date);
				msgDate.setHours(0, 0, 0, 0);
				return msgDate.getTime() === today.getTime();
			});

			// Extract student name from user object
			let studentName = '';
			if (this.edupageClient.user) {
				studentName = this.edupageClient.user.name || 
					(this.edupageClient.user.firstName && this.edupageClient.user.lastName 
						? `${this.edupageClient.user.firstName} ${this.edupageClient.user.lastName}` 
						: '') || '';
			}

			// Extract unique teachers from homeworks and notifications
			const teachersSet = new Set();
			homeworksData.forEach(hw => {
				if (hw.teacher) teachersSet.add(hw.teacher);
			});
			timelineData.forEach(msg => {
				if (msg.author) teachersSet.add(msg.author);
			});
			const teachersList = Array.from(teachersSet).sort();

			// Extract unique subjects/classes from homeworks
			const classesSet = new Set();
			homeworksData.forEach(hw => {
				if (hw.subject) classesSet.add(hw.subject);
			});
			const classesList = Array.from(classesSet).sort();

			// Save homeworks data (legacy states for backward compatibility)
			const homeworkJson = JSON.stringify(homeworksData);
			await this.setState('data.homework_json', { val: homeworkJson, ack: true });
			await this.setState('data.homework_count', { val: homeworks.length, ack: true });

			// Save pending and completed homeworks
			const pendingJson = JSON.stringify(pendingHomeworks);
			const completedJson = JSON.stringify(completedHomeworks);
			await this.setState('data.homework.pending_json', { val: pendingJson, ack: true });
			await this.setState('data.homework.completed_json', { val: completedJson, ack: true });

			// Save notifications data (legacy states for backward compatibility)
			const notificationsJson = JSON.stringify(timelineData);
			await this.setState('data.notifications_json', { val: notificationsJson, ack: true });
			await this.setState('data.notifications_count', { val: timeline.length, ack: true });

			// Save today's and all notifications
			const todayNotificationsJson = JSON.stringify(todayNotifications);
			await this.setState('data.notifications.today_json', { val: todayNotificationsJson, ack: true });
			await this.setState('data.notifications.all_json', { val: notificationsJson, ack: true });

			// Save general info
			await this.setState('info.student_name', { val: studentName, ack: true });
			await this.setState('info.teachers_json', { val: JSON.stringify(teachersList), ack: true });
			await this.setState('info.classes_json', { val: JSON.stringify(classesList), ack: true });

			this.log.debug(`Synced ${homeworks.length} homeworks (${pendingHomeworks.length} pending, ${completedHomeworks.length} completed) and ${timeline.length} notifications (${todayNotifications.length} today)`);

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
