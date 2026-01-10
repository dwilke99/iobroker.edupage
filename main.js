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
		const studentName = this.config.studentName || '';

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

			// Log student filtering info if configured
			if (studentName) {
				this.log.info(`Student name filter configured: ${studentName}. Using main account data (API doesn't support direct filtering).`);
			}

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
	 * Calculate the next school day from a given date
	 * If date is Friday, Saturday, or Sunday -> returns Monday
	 * Otherwise -> returns date + 1 day
	 * @param {Date} date - Starting date
	 * @returns {Date} Next school day
	 */
	getNextSchoolDay(date) {
		const dayOfWeek = date.getDay(); // 0 = Sunday, 5 = Friday, 6 = Saturday
		const nextDay = new Date(date);
		
		if (dayOfWeek === 5) { // Friday
			nextDay.setDate(date.getDate() + 3); // Monday
		} else if (dayOfWeek === 6) { // Saturday
			nextDay.setDate(date.getDate() + 2); // Monday
		} else if (dayOfWeek === 0) { // Sunday
			nextDay.setDate(date.getDate() + 1); // Monday
		} else {
			nextDay.setDate(date.getDate() + 1); // Next day
		}
		
		nextDay.setHours(0, 0, 0, 0);
		return nextDay;
	}

	/**
	 * Fetch canteen menu for a specific date
	 * @param {Date} date - Date to fetch menu for
	 * @returns {Promise<Object|null>} Menu data or null if error
	 */
	async fetchMenu(date) {
		if (!this.edupageClient) {
			return null;
		}

		try {
			// Format date as YYYY-MM-DD
			const dateStr = date.toISOString().split('T')[0];
			
			// Try different endpoint formats - the menu endpoint format may vary
			// Format 1: /strava/?akcia=stravamenu (similar to timeline pattern)
			let menuUrl = `${this.edupageClient.baseUrl}/strava/?akcia=stravamenu`;
			
			// Use the API method to fetch menu data
			// Note: Menu endpoint might not be available for all schools
			let menuData;
			try {
				menuData = await this.edupageClient.api({
					url: menuUrl,
					data: {
						datefrom: dateStr,
						dateto: dateStr,
					},
					autoLogin: false, // Prevent auto-login retry loops
				});
			} catch (firstError) {
				// Try alternative format: /strava/stravamenu
				this.log.debug(`Trying alternative menu endpoint format for ${dateStr}`);
				menuUrl = `${this.edupageClient.baseUrl}/strava/stravamenu`;
				try {
					menuData = await this.edupageClient.api({
						url: menuUrl,
						data: {
							datefrom: dateStr,
							dateto: dateStr,
						},
						autoLogin: false,
					});
				} catch (secondError) {
					// Both formats failed
					throw firstError;
				}
			}

			// Check if we got valid menu data
			if (menuData && (menuData.menu || menuData.dishes || menuData.items || menuData.data || menuData.result)) {
				return menuData;
			}
			
			// Menu might not be available for this school/date
			return null;
		} catch (error) {
			// Menu functionality might not be available for all schools
			// Only log at debug level to avoid warning spam
			this.log.debug(`Menu not available for ${date.toISOString().split('T')[0]}: ${error.message}`);
			return null;
		}
	}

	/**
	 * Extract main dish from menu data
	 * @param {Object} menuData - Menu data from API
	 * @returns {string} Main dish name or empty string
	 */
	extractMainDish(menuData) {
		if (!menuData || !menuData.menu) {
			return '';
		}

		// Try to find Menu A or the first main dish
		const menu = menuData.menu;
		
		// Check for Menu A
		if (menu.menuA && menu.menuA.name) {
			return menu.menuA.name;
		}
		
		// Check for dishes array
		if (menu.dishes && Array.isArray(menu.dishes) && menu.dishes.length > 0) {
			const firstDish = menu.dishes[0];
			if (firstDish.name) {
				return firstDish.name;
			}
		}
		
		// Check for items array
		if (menu.items && Array.isArray(menu.items) && menu.items.length > 0) {
			const firstItem = menu.items[0];
			if (firstItem.name || firstItem.title) {
				return firstItem.name || firstItem.title;
			}
		}

		// Fallback: try to find any dish name in the structure
		if (menu.name) {
			return menu.name;
		}

		return '';
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

			// Calculate today and next school day
			const today = new Date();
			today.setHours(0, 0, 0, 0);
			const nextSchoolDay = this.getNextSchoolDay(today);

			let todayTimetable = null;
			let nextSchoolDayTimetable = null;

			try {
				todayTimetable = await this.edupageClient.getTimetableForDate(today);
			} catch (error) {
				this.log.warn(`Failed to fetch today's timetable: ${error.message}`);
			}

			try {
				nextSchoolDayTimetable = await this.edupageClient.getTimetableForDate(nextSchoolDay);
			} catch (error) {
				this.log.warn(`Failed to fetch next school day's timetable: ${error.message}`);
			}

			// Fetch canteen menu for today and next school day
			let todayMenu = null;
			let nextSchoolDayMenu = null;

			try {
				todayMenu = await this.fetchMenu(today);
			} catch (error) {
				this.log.warn(`Failed to fetch today's menu: ${error.message}`);
			}

			try {
				nextSchoolDayMenu = await this.fetchMenu(nextSchoolDay);
			} catch (error) {
				this.log.warn(`Failed to fetch next school day's menu: ${error.message}`);
			}

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

			// Filter notifications by today's date (reuse today variable from above)
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

			// Extract unique teachers from homeworks, notifications, and timetable
			const teachersMap = new Map(); // Use Map to store teacher -> subject mapping
			
			// From homeworks
			homeworksData.forEach(hw => {
				if (hw.teacher && hw.subject) {
					if (!teachersMap.has(hw.teacher)) {
						teachersMap.set(hw.teacher, hw.subject);
					}
				}
			});
			
			// From notifications
			timelineData.forEach(msg => {
				if (msg.author) {
					if (!teachersMap.has(msg.author)) {
						teachersMap.set(msg.author, null);
					}
				}
			});

			// From timetable lessons
			if (todayTimetable && todayTimetable.lessons) {
				todayTimetable.lessons.forEach(lesson => {
					if (lesson.teachers && lesson.teachers.length > 0 && lesson.subject) {
						lesson.teachers.forEach(teacher => {
							const teacherName = teacher.name || teacher.toString();
							if (!teachersMap.has(teacherName)) {
								teachersMap.set(teacherName, lesson.subject.name || null);
							}
						});
					}
				});
			}

			if (nextSchoolDayTimetable && nextSchoolDayTimetable.lessons) {
				nextSchoolDayTimetable.lessons.forEach(lesson => {
					if (lesson.teachers && lesson.teachers.length > 0 && lesson.subject) {
						lesson.teachers.forEach(teacher => {
							const teacherName = teacher.name || teacher.toString();
							if (!teachersMap.has(teacherName)) {
								teachersMap.set(teacherName, lesson.subject.name || null);
							}
						});
					}
				});
			}

			// Convert to array of objects
			const teachersList = Array.from(teachersMap.entries()).map(([name, subject]) => ({
				name: name,
				subject: subject
			})).sort((a, b) => a.name.localeCompare(b.name));

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

			// Process timetable lessons for today
			let todayLessons = [];
			if (todayTimetable && todayTimetable.lessons) {
				todayLessons = todayTimetable.lessons.map(lesson => {
					const teacherNames = lesson.teachers && lesson.teachers.length > 0
						? lesson.teachers.map(t => t.name || t.toString()).join(', ')
						: null;
					
					return {
						period: lesson.period ? {
							id: lesson.period.id,
							name: lesson.period.name || null,
							startTime: lesson.period.startTime || null,
							endTime: lesson.period.endTime || null
						} : null,
						subject: lesson.subject ? lesson.subject.name : null,
						teacher: teacherNames,
						topic: lesson.curriculum || null,
						classroom: lesson.classrooms && lesson.classrooms.length > 0
							? lesson.classrooms.map(c => c.name || c.toString()).join(', ')
							: null,
						date: lesson.date ? lesson.date.toISOString() : null
					};
				});
			}

			// Process timetable lessons for next school day
			let nextSchoolDayLessons = [];
			if (nextSchoolDayTimetable && nextSchoolDayTimetable.lessons) {
				nextSchoolDayLessons = nextSchoolDayTimetable.lessons.map(lesson => {
					const teacherNames = lesson.teachers && lesson.teachers.length > 0
						? lesson.teachers.map(t => t.name || t.toString()).join(', ')
						: null;
					
					return {
						period: lesson.period ? {
							id: lesson.period.id,
							name: lesson.period.name || null,
							startTime: lesson.period.startTime || null,
							endTime: lesson.period.endTime || null
						} : null,
						subject: lesson.subject ? lesson.subject.name : null,
						teacher: teacherNames,
						topic: lesson.curriculum || null,
						classroom: lesson.classrooms && lesson.classrooms.length > 0
							? lesson.classrooms.map(c => c.name || c.toString()).join(', ')
							: null,
						date: lesson.date ? lesson.date.toISOString() : null
					};
				});
			}

			// Save general info
			const configStudentName = this.config.studentName || '';
			const extractedStudentName = studentName || configStudentName;
			await this.setState('info.student_name', { val: extractedStudentName, ack: true });
			await this.setState('info.teachers_json', { val: JSON.stringify(teachersList), ack: true });
			await this.setState('info.classes_json', { val: JSON.stringify(classesList), ack: true });

			// Save timetable data
			await this.setState('data.classes.today_json', { val: JSON.stringify(todayLessons), ack: true });
			await this.setState('data.classes.tomorrow_json', { val: JSON.stringify(nextSchoolDayLessons), ack: true });

			// Process and save canteen menu data
			const todayMenuJson = todayMenu ? JSON.stringify(todayMenu) : JSON.stringify({});
			const nextSchoolDayMenuJson = nextSchoolDayMenu ? JSON.stringify(nextSchoolDayMenu) : JSON.stringify({});
			const nextSchoolDayMainDish = nextSchoolDayMenu ? this.extractMainDish(nextSchoolDayMenu) : '';

			await this.setState('data.canteen.today_json', { val: todayMenuJson, ack: true });
			await this.setState('data.canteen.tomorrow_json', { val: nextSchoolDayMenuJson, ack: true });
			await this.setState('data.canteen.tomorrow_text', { val: nextSchoolDayMainDish, ack: true });

			this.log.debug(`Synced ${homeworks.length} homeworks (${pendingHomeworks.length} pending, ${completedHomeworks.length} completed), ${timeline.length} notifications (${todayNotifications.length} today), ${todayLessons.length} lessons today, ${nextSchoolDayLessons.length} lessons next school day`);

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
