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
		this.studentId = null; // Store student ID if studentName is configured
		this.targetStudent = null; // Store target student object if studentName is configured
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

			// Get and log all available students (children for parent accounts)
			const availableStudents = this.edupageClient.students || [];
			this.log.info(`Found ${availableStudents.length} student(s) in account:`);
			availableStudents.forEach(student => {
				const fullName = student.name || 
					(student.firstname && student.lastname ? `${student.firstname} ${student.lastname}` : 
					(student.firstName && student.lastName ? `${student.firstName} ${student.lastName}` : 'Unknown'));
				this.log.info(`  Gefundenes Kind: ${fullName}`);
			});

			// Look up target student if studentName is configured
			if (studentName) {
				// Search for exact match first, then partial match
				const foundStudent = availableStudents.find(student => {
					const fullName = student.name || 
						(student.firstname && student.lastname ? `${student.firstname} ${student.lastname}` : 
						(student.firstName && student.lastName ? `${student.firstName} ${student.lastName}` : ''));
					// Try exact match first
					return fullName === studentName || fullName.toLowerCase() === studentName.toLowerCase();
				}) || availableStudents.find(student => {
					const fullName = student.name || 
						(student.firstname && student.lastname ? `${student.firstname} ${student.lastname}` : 
						(student.firstName && student.lastName ? `${student.firstName} ${student.lastName}` : ''));
					// Fallback to partial match
					return fullName.toLowerCase().includes(studentName.toLowerCase()) ||
						studentName.toLowerCase().includes(fullName.toLowerCase());
				});

				if (foundStudent) {
					this.targetStudent = foundStudent;
					this.studentId = foundStudent.id;
					const fullName = foundStudent.name || 
						(foundStudent.firstname && foundStudent.lastname ? `${foundStudent.firstname} ${foundStudent.lastname}` : 
						(foundStudent.firstName && foundStudent.lastName ? `${foundStudent.firstName} ${foundStudent.lastName}` : 'Unknown'));
					this.log.info(`Selected student: ${fullName} (ID: ${this.studentId})`);
				} else {
					this.log.warn(`Student "${studentName}" not found in students list. Available students logged above. Using main account data.`);
					this.targetStudent = null;
					this.studentId = null;
				}
			} else {
				this.targetStudent = null;
				this.studentId = null;
				this.log.info('No student name configured. Using main account data.');
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
	 * Get all weekdays (Monday to Friday) for the current week
	 * @returns {Date[]} Array of Date objects for Monday through Friday
	 */
	getCurrentWeekDays() {
		const today = new Date();
		today.setHours(0, 0, 0, 0);
		
		// Get Monday of current week
		const dayOfWeek = today.getDay(); // 0 = Sunday, 1 = Monday, ..., 6 = Saturday
		const monday = new Date(today);
		
		// Calculate days to subtract to get to Monday
		// If today is Sunday (0), go back 6 days; if Monday (1), go back 0 days, etc.
		const daysToMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
		monday.setDate(today.getDate() - daysToMonday);
		
		// Generate array of Monday through Friday
		const weekDays = [];
		for (let i = 0; i < 5; i++) {
			const day = new Date(monday);
			day.setDate(monday.getDate() + i);
			weekDays.push(day);
		}
		
		return weekDays;
	}

	/**
	 * Fetch meals/menu for a specific date using the Edupage API
	 * @param {Date} date - Date to fetch meals for
	 * @returns {Promise<string|null>} Main dish text or null if error/not available
	 */
	async getMeals(date) {
		if (!this.edupageClient) {
			return null;
		}

		try {
			// Format date as YYYY-MM-DD
			const dateStr = date.toISOString().split('T')[0];
			
			// Try different endpoint formats - the menu endpoint format may vary
			let menuData = null;
			let lastError = null;
			
			// Try Format 1: Server-side script pattern
			try {
				const menuUrl1 = `${this.edupageClient.baseUrl}/strava/server/stravamenu.js?__func=getMenu`;
				menuData = await this.edupageClient.api({
					url: menuUrl1,
					data: {
						datefrom: dateStr,
						dateto: dateStr,
					},
					autoLogin: false,
				});
				if (menuData && (menuData.menu || menuData.dishes || menuData.items || menuData.data || menuData.result)) {
					return this.extractMealText(menuData);
				}
			} catch (error1) {
				lastError = error1;
			}
			
			// Try Format 2: Timeline-style endpoint
			try {
				const menuUrl2 = `${this.edupageClient.baseUrl}/strava/?akcia=stravamenu`;
				menuData = await this.edupageClient.api({
					url: menuUrl2,
					data: {
						datefrom: dateStr,
						dateto: dateStr,
					},
					autoLogin: false,
				});
				if (menuData && (menuData.menu || menuData.dishes || menuData.items || menuData.data || menuData.result)) {
					return this.extractMealText(menuData);
				}
			} catch (error2) {
				lastError = error2;
			}
			
			// Try Format 3: Direct endpoint
			try {
				const menuUrl3 = `${this.edupageClient.baseUrl}/strava/stravamenu`;
				menuData = await this.edupageClient.api({
					url: menuUrl3,
					data: {
						datefrom: dateStr,
						dateto: dateStr,
					},
					autoLogin: false,
				});
				if (menuData && (menuData.menu || menuData.dishes || menuData.items || menuData.data || menuData.result)) {
					return this.extractMealText(menuData);
				}
			} catch (error3) {
				// All formats failed
			}
			
			// All formats failed or returned empty data
			this.log.debug(`Meals not available for ${dateStr}`);
			return null;
		} catch (error) {
			this.log.debug(`Error fetching meals for ${date.toISOString().split('T')[0]}: ${error.message}`);
			return null;
		}
	}

	/**
	 * Extract meal text from menu data response
	 * @param {object} menuData - Menu data from API response
	 * @returns {string|null} Main dish text or null
	 */
	extractMealText(menuData) {
		if (!menuData) {
			return null;
		}

		// Handle different response structures
		// Check if response is a list/array
		if (Array.isArray(menuData)) {
			if (menuData.length > 0) {
				const firstItem = menuData[0];
				return firstItem.text || firstItem.description || firstItem.name || firstItem.title || null;
			}
			return null;
		}

		// Check if response contains a list/array in a property
		if (menuData.dishes && Array.isArray(menuData.dishes) && menuData.dishes.length > 0) {
			const firstDish = menuData.dishes[0];
			return firstDish.text || firstDish.description || firstDish.name || firstDish.title || null;
		}

		if (menuData.items && Array.isArray(menuData.items) && menuData.items.length > 0) {
			const firstItem = menuData.items[0];
			return firstItem.text || firstItem.description || firstItem.name || firstItem.title || null;
		}

		if (menuData.data && Array.isArray(menuData.data) && menuData.data.length > 0) {
			const firstItem = menuData.data[0];
			return firstItem.text || firstItem.description || firstItem.name || firstItem.title || null;
		}

		if (menuData.result && Array.isArray(menuData.result) && menuData.result.length > 0) {
			const firstItem = menuData.result[0];
			return firstItem.text || firstItem.description || firstItem.name || firstItem.title || null;
		}

		// Check for menu object structure
		if (menuData.menu) {
			const menu = menuData.menu;
			
			// Check for Menu A
			if (menu.menuA && menu.menuA.name) {
				return menu.menuA.name;
			}
			
			// Check for dishes array in menu
			if (menu.dishes && Array.isArray(menu.dishes) && menu.dishes.length > 0) {
				const firstDish = menu.dishes[0];
				return firstDish.text || firstDish.description || firstDish.name || firstDish.title || null;
			}
			
			// Check for items array in menu
			if (menu.items && Array.isArray(menu.items) && menu.items.length > 0) {
				const firstItem = menu.items[0];
				return firstItem.text || firstItem.description || firstItem.name || firstItem.title || null;
			}
			
			// Fallback: menu name
			if (menu.name) {
				return menu.name;
			}
		}

		// Direct text/description/name fields
		if (menuData.text) {
			return menuData.text;
		}
		if (menuData.description) {
			return menuData.description;
		}
		if (menuData.name) {
			return menuData.name;
		}

		return null;
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

			// Refresh global data to ensure teachers are loaded
			await this.edupageClient.refreshEdupage();

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

			// Access homeworks and timeline (notifications) as properties
			let homeworks = this.edupageClient.homeworks || [];
			let timeline = this.edupageClient.timeline || [];

			// Filter by target student if configured
			if (this.targetStudent && this.studentId) {
				// Filter homeworks by student
				homeworks = homeworks.filter(hw => {
					// Check if homework is assigned to our target student
					// Homeworks might have student IDs in the data structure
					if (hw.students && Array.isArray(hw.students)) {
						return hw.students.some(s => s.id === this.studentId);
					}
					// If no students array, include it (might be class-wide)
					return true;
				});

				// Filter timeline/notifications by student
				timeline = timeline.filter(msg => {
					// Check if message is for our target student
					if (msg.students && Array.isArray(msg.students)) {
						return msg.students.some(s => s.id === this.studentId);
					}
					// Check if message author is our target student
					if (msg.author && msg.author.id === this.studentId) {
						return true;
					}
					// If no student filter, include it (might be general)
					return true;
				});
			}

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

			// Extract student name - use target student if configured, otherwise use logged-in user
			let extractedStudentName = '';
			if (this.targetStudent) {
				extractedStudentName = this.targetStudent.name || 
					(this.targetStudent.firstname && this.targetStudent.lastname 
						? `${this.targetStudent.firstname} ${this.targetStudent.lastname}` 
						: (this.targetStudent.firstName && this.targetStudent.lastName 
							? `${this.targetStudent.firstName} ${this.targetStudent.lastName}` 
							: '')) || '';
			} else if (this.edupageClient.user) {
				extractedStudentName = this.edupageClient.user.name || 
					(this.edupageClient.user.firstName && this.edupageClient.user.lastName 
						? `${this.edupageClient.user.firstName} ${this.edupageClient.user.lastName}` 
						: (this.edupageClient.user.firstname && this.edupageClient.user.lastname
							? `${this.edupageClient.user.firstname} ${this.edupageClient.user.lastname}`
							: '')) || '';
			}

			// Get teachers from the official API (refreshEdupage() populates this.edupageClient.teachers)
			const teachersList = (this.edupageClient.teachers || [])
				.map(teacher => {
					let teacherName = teacher.name;
					if (!teacherName && teacher.firstName && teacher.lastName) {
						teacherName = `${teacher.firstName} ${teacher.lastName}`;
					}
					if (!teacherName && teacher.firstname && teacher.lastname) {
						teacherName = `${teacher.firstname} ${teacher.lastname}`;
					}
					return {
						id: teacher.id || null,
						name: teacherName || null,
						short: teacher.short || null
					};
				})
				.filter(teacher => teacher.name !== null)
				.sort((a, b) => {
					const nameA = a.name || '';
					const nameB = b.name || '';
					return nameA.localeCompare(nameB);
				});

			this.log.debug(`Found ${teachersList.length} teachers from API`);

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
				// Filter lessons by student ID if configured
				let lessonsToProcess = todayTimetable.lessons;
				if (this.studentId) {
					lessonsToProcess = todayTimetable.lessons.filter(lesson => {
						// Check if this lesson includes our student
						if (lesson.students && Array.isArray(lesson.students)) {
							return lesson.students.some(student => student.id === this.studentId);
						}
						// If no students array, include the lesson (might be class-wide)
						return true;
					});
				}

				todayLessons = lessonsToProcess.map(lesson => {
					const teacherNames = lesson.teachers && lesson.teachers.length > 0
						? lesson.teachers.map(t => t.name || t.toString()).join(', ')
						: null;
					
					// Extract period number (e.g., "1", "2", etc.) - use name or id
					const periodNumber = lesson.period ? (lesson.period.name || String(lesson.period.id) || null) : null;
					
					return {
						period: periodNumber,
						startTime: lesson.period && lesson.period.startTime ? lesson.period.startTime : null,
						endTime: lesson.period && lesson.period.endTime ? lesson.period.endTime : null,
						subject: lesson.subject ? lesson.subject.name : null,
						teacher: teacherNames,
						topic: lesson.curriculum || null,
						classroom: lesson.classrooms && lesson.classrooms.length > 0
							? lesson.classrooms.map(c => c.name || c.toString()).join(', ')
							: null,
						date: lesson.date ? lesson.date.toISOString().split('T')[0] : null
					};
				});
			}

			// Process timetable lessons for next school day
			let nextSchoolDayLessons = [];
			if (nextSchoolDayTimetable && nextSchoolDayTimetable.lessons) {
				// Filter lessons by student ID if configured
				let lessonsToProcess = nextSchoolDayTimetable.lessons;
				if (this.studentId) {
					lessonsToProcess = nextSchoolDayTimetable.lessons.filter(lesson => {
						// Check if this lesson includes our student
						if (lesson.students && Array.isArray(lesson.students)) {
							return lesson.students.some(student => student.id === this.studentId);
						}
						// If no students array, include the lesson (might be class-wide)
						return true;
					});
				}

				nextSchoolDayLessons = lessonsToProcess.map(lesson => {
					const teacherNames = lesson.teachers && lesson.teachers.length > 0
						? lesson.teachers.map(t => t.name || t.toString()).join(', ')
						: null;
					
					// Extract period number (e.g., "1", "2", etc.) - use name or id
					const periodNumber = lesson.period ? (lesson.period.name || String(lesson.period.id) || null) : null;
					
					return {
						period: periodNumber,
						startTime: lesson.period && lesson.period.startTime ? lesson.period.startTime : null,
						endTime: lesson.period && lesson.period.endTime ? lesson.period.endTime : null,
						subject: lesson.subject ? lesson.subject.name : null,
						teacher: teacherNames,
						topic: lesson.curriculum || null,
						classroom: lesson.classrooms && lesson.classrooms.length > 0
							? lesson.classrooms.map(c => c.name || c.toString()).join(', ')
							: null,
						date: lesson.date ? lesson.date.toISOString().split('T')[0] : null
					};
				});
			}

			// Save general info
			await this.setState('info.student_name', { val: extractedStudentName, ack: true });
			await this.setState('info.teachers_json', { val: JSON.stringify(teachersList), ack: true });
			await this.setState('info.classes_json', { val: JSON.stringify(classesList), ack: true });

			// Save timetable data
			await this.setState('data.classes.today_json', { val: JSON.stringify(todayLessons), ack: true });
			await this.setState('data.classes.tomorrow_json', { val: JSON.stringify(nextSchoolDayLessons), ack: true });

			// Fetch meals for today and next school day using getMeals()
			let todayMeal = null;
			let nextSchoolDayMeal = null;

			try {
				todayMeal = await this.getMeals(today);
			} catch (error) {
				this.log.debug(`Failed to fetch today's meal: ${error.message}`);
			}

			try {
				nextSchoolDayMeal = await this.getMeals(nextSchoolDay);
			} catch (error) {
				this.log.debug(`Failed to fetch next school day's meal: ${error.message}`);
			}

			// Save today's meal
			const todayMealJson = JSON.stringify({
				date: today.toISOString().split('T')[0],
				menu: todayMeal || 'Keine Daten'
			});
			await this.setState('data.canteen.today_json', { val: todayMealJson, ack: true });

			// Save next school day's meal
			const nextSchoolDayMealJson = JSON.stringify({
				date: nextSchoolDay.toISOString().split('T')[0],
				menu: nextSchoolDayMeal || 'Keine Daten'
			});
			await this.setState('data.canteen.tomorrow_json', { val: nextSchoolDayMealJson, ack: true });
			await this.setState('data.canteen.tomorrow_text', { val: nextSchoolDayMeal || 'Keine Daten', ack: true });

			// Fetch weekly menu (Monday to Friday) using getMeals()
			const weekDays = this.getCurrentWeekDays();
			const weekMenuData = [];
			const dayNames = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'];

			for (let i = 0; i < weekDays.length; i++) {
				const day = weekDays[i];
				const dateStr = day.toISOString().split('T')[0];
				
				try {
					const mealText = await this.getMeals(day);
					
					weekMenuData.push({
						date: dateStr,
						day: dayNames[i],
						menu: mealText || 'Keine Daten'
					});
				} catch (error) {
					this.log.debug(`Failed to fetch meal for ${dateStr}: ${error.message}`);
					// Add entry with "Keine Daten" if error
					weekMenuData.push({
						date: dateStr,
						day: dayNames[i],
						menu: 'Keine Daten'
					});
				}
			}

			// Sort by date (should already be sorted, but ensure it)
			weekMenuData.sort((a, b) => a.date.localeCompare(b.date));

			// Save weekly menu data
			await this.setState('data.canteen.week_json', { val: JSON.stringify(weekMenuData), ack: true });
			this.log.debug(`Fetched meals for ${weekMenuData.length} days`);

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
