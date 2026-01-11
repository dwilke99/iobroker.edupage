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

			// Get all available students (children for parent accounts)
			const availableStudents = this.edupageClient.students || [];
			this.log.info(`Found ${availableStudents.length} student(s) in account:`);
			availableStudents.forEach(student => {
				const fullName = student.name ||
					(student.firstname && student.lastname ? `${student.firstname} ${student.lastname}` :
						(student.firstName && student.lastName ? `${student.firstName} ${student.lastName}` : 'Unknown'));
				this.log.info(`  Available student: ${fullName}`);
			});

			// Student selection logic
			if (studentName && studentName.trim()) {
				// Search for matching student
				const foundStudent = availableStudents.find(student => {
					const fullName = student.name ||
						(student.firstname && student.lastname ? `${student.firstname} ${student.lastname}` :
							(student.firstName && student.lastName ? `${student.firstName} ${student.lastName}` : ''));
					// Try exact match first (case-insensitive)
					return fullName && fullName.toLowerCase() === studentName.trim().toLowerCase();
				}) || availableStudents.find(student => {
					const fullName = student.name ||
						(student.firstname && student.lastname ? `${student.firstname} ${student.lastname}` :
							(student.firstName && student.lastName ? `${student.firstName} ${student.lastName}` : ''));
					// Fallback to partial match
					return fullName && (
						fullName.toLowerCase().includes(studentName.trim().toLowerCase()) ||
						studentName.trim().toLowerCase().includes(fullName.toLowerCase())
					);
				});

				if (foundStudent) {
					this.targetStudent = foundStudent;
					this.studentId = foundStudent.id;
					const fullName = foundStudent.name ||
						(foundStudent.firstname && foundStudent.lastname ? `${foundStudent.firstname} ${foundStudent.lastname}` :
							(foundStudent.firstName && foundStudent.lastName ? `${foundStudent.firstName} ${foundStudent.lastName}` : 'Unknown'));
					this.log.info(`Using student: ${fullName} (ID: ${this.studentId})`);
				} else {
					this.log.warn(`Student "${studentName}" not found. Available students logged above. Using main account data.`);
					// Default to first student if available, otherwise main account
					if (availableStudents.length > 0) {
						this.targetStudent = availableStudents[0];
						this.studentId = availableStudents[0].id;
						const defaultName = availableStudents[0].name ||
							(availableStudents[0].firstname && availableStudents[0].lastname ? `${availableStudents[0].firstname} ${availableStudents[0].lastname}` :
								(availableStudents[0].firstName && availableStudents[0].lastName ? `${availableStudents[0].firstName} ${availableStudents[0].lastName}` : 'Unknown'));
						this.log.warn(`Defaulting to first available student: ${defaultName}`);
					} else {
						this.targetStudent = null;
						this.studentId = null;
					}
				}
			} else {
				// No student name configured - use first student if available, otherwise main account
				if (availableStudents.length > 0) {
					this.targetStudent = availableStudents[0];
					this.studentId = availableStudents[0].id;
					const defaultName = availableStudents[0].name ||
						(availableStudents[0].firstname && availableStudents[0].lastname ? `${availableStudents[0].firstname} ${availableStudents[0].lastname}` :
							(availableStudents[0].firstName && availableStudents[0].lastName ? `${availableStudents[0].firstName} ${availableStudents[0].lastName}` : 'Unknown'));
					this.log.info(`No student name configured. Using first available student: ${defaultName}`);
				} else {
					this.targetStudent = null;
					this.studentId = null;
					this.log.info('No student name configured. Using main account data.');
				}
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
	 * Generate HTML for homework visualization using absolute positioning
	 * @param {Array} pending - Array of pending homework items
	 * @param {Array} completed - Array of completed homework items
	 * @returns {string} HTML string ready for VIS
	 */
	generateHomeworkHTML(pending, completed) {
		const today = new Date();
		today.setHours(0, 0, 0, 0);
		const tomorrow = new Date(today);
		tomorrow.setDate(today.getDate() + 1);

		// Categorize and sort pending items
		const overdue = [];
		const upcoming = [];

		pending.forEach(hw => {
			if (!hw.dueDate) {
				upcoming.push(hw);
				return;
			}

			const dueDate = new Date(hw.dueDate);
			dueDate.setHours(0, 0, 0, 0);

			if (dueDate.getTime() < today.getTime()) {
				overdue.push(hw);
			} else {
				upcoming.push(hw);
			}
		});

		// Sort overdue: newest overdue first
		overdue.sort((a, b) => {
			const dateA = a.dueDate ? new Date(a.dueDate).getTime() : 0;
			const dateB = b.dueDate ? new Date(b.dueDate).getTime() : 0;
			return dateB - dateA; // Descending (newest first)
		});

		// Sort upcoming: sooner due dates first
		upcoming.sort((a, b) => {
			const dateA = a.dueDate ? new Date(a.dueDate).getTime() : 9999999999999;
			const dateB = b.dueDate ? new Date(b.dueDate).getTime() : 9999999999999;
			return dateA - dateB; // Ascending (soonest first)
		});

		// Sort completed: newest done first, limit to 2
		const history = [...completed]
			.sort((a, b) => {
				const dateA = a.dueDate ? new Date(a.dueDate).getTime() : 0;
				const dateB = b.dueDate ? new Date(b.dueDate).getTime() : 0;
				return dateB - dateA; // Descending (newest first)
			})
			.slice(0, 2);

		// Format current time
		const now = new Date();
		const timeStr = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

		// Helper function to format date
		const formatDate = (dateStr) => {
			if (!dateStr) {
				return '';
			}
			const date = new Date(dateStr);
			const day = String(date.getDate()).padStart(2, '0');
			const month = String(date.getMonth() + 1).padStart(2, '0');
			// Get day name
			const dayNames = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];
			const dayName = dayNames[date.getDay()];
			return `${dayName}, ${day}.${month}.`;
		};

		// Helper function to get border color based on card type
		const getBorderColor = (dateStr) => {
			if (!dateStr) {
				return '#3498db'; // Future - blue
			}

			const dueDate = new Date(dateStr);
			dueDate.setHours(0, 0, 0, 0);

			if (dueDate.getTime() === today.getTime()) {
				return '#e67e22'; // Today - orange
			}
			if (dueDate.getTime() < today.getTime()) {
				return '#e74c3c'; // Overdue - red
			}
			return '#3498db'; // Future - blue
		};

		// Helper function to escape HTML
		const escapeHtml = (text) => {
			if (!text) {
				return '';
			}
			return String(text)
				.replace(/&/g, '&amp;')
				.replace(/</g, '&lt;')
				.replace(/>/g, '&gt;')
				.replace(/"/g, '&quot;')
				.replace(/'/g, '&#039;');
		};

		// Helper function to create a card HTML
		const createCard = (hw, isCompleted = false) => {
			const subject = escapeHtml(hw.subject || 'Kein Fach');
			const body = escapeHtml(hw.description || hw.title || '');
			const dueDateStr = formatDate(hw.dueDate);
			const borderColor = isCompleted ? '#ccc' : getBorderColor(hw.dueDate);
			const opacity = isCompleted ? '0.7' : '1';

			let cardHtml = `<div style="background-color: #2d3436; border-left: 4px solid ${borderColor}; margin-bottom: 10px; padding: 12px; border-radius: 4px; opacity: ${opacity};">`;
			cardHtml += `<div style="font-weight: bold; font-size: 16px; color: #fff; margin-bottom: 4px;">${subject}</div>`;
			if (dueDateStr) {
				cardHtml += `<div style="font-size: 12px; color: #95a5a6; margin-bottom: 8px;">${dueDateStr}</div>`;
			}
			if (body) {
				cardHtml += `<div style="font-size: 14px; color: #ecf0f1; line-height: 1.4;">${body}</div>`;
			}
			cardHtml += '</div>';
			return cardHtml;
		};

		// Build HTML with absolute positioning
		const totalCount = pending.length + completed.length;
		let html = '<div style="position: relative; width: 100%; height: 100%; overflow: hidden; background: #1e1e1e; font-family: \'Segoe UI\', Arial, sans-serif;">';
		
		// Header (Fixed) - Absolute positioned
		html += '<div style="position: absolute; top: 0; left: 0; right: 0; height: 50px; background: #2d3436; color: #fff; padding: 0 15px; display: flex; align-items: center; justify-content: space-between; border-bottom: 1px solid #444; box-sizing: border-box; z-index: 10;">';
		html += `<div>📝 Hausaufgaben <span style="background: #00b894; color: #fff; padding: 2px 8px; border-radius: 12px; font-size: 12px; font-weight: bold;">${totalCount}</span></div>`;
		html += `<div style="font-size: 11px; color: #ccc;">Stand: ${timeStr}</div>`;
		html += '</div>';

		// Content (Scrollable) - Absolute positioned
		html += '<div style="position: absolute; top: 50px; bottom: 0; left: 0; right: 0; overflow-y: auto; padding: 10px; box-sizing: border-box;">';

		// Upcoming section (show FIRST)
		if (upcoming.length > 0) {
			upcoming.forEach(hw => {
				html += createCard(hw, false);
			});
		}

		// Overdue section (show SECOND with separator)
		if (overdue.length > 0) {
			if (upcoming.length > 0) {
				html += '<div style="color: #e74c3c; font-weight: bold; font-size: 14px; margin: 16px 0 8px 0; padding-top: 16px; border-top: 1px solid #444;">Fällig</div>';
			}
			overdue.forEach(hw => {
				html += createCard(hw, false);
			});
		}

		// History section (completed) - show LAST
		if (history.length > 0) {
			html += '<div style="color: #95a5a6; font-weight: bold; font-size: 14px; margin: 16px 0 8px 0; padding-top: 16px; border-top: 1px solid #444;">Erledigt</div>';
			history.forEach(hw => {
				html += createCard(hw, true);
			});
		}

		// Empty state
		if (overdue.length === 0 && upcoming.length === 0 && history.length === 0) {
			html += '<div style="text-align: center; padding: 40px 20px; color: #95a5a6; font-size: 16px;">Keine Hausaufgaben</div>';
		}

		html += '</div>'; // Close content
		html += '</div>'; // Close container
		return html;
	}

	/**
	 * Generate HTML for timetable visualization using CSS classes
	 * @param {Array} lessons - Array of lesson objects for today
	 * @returns {string} HTML string ready for VIS
	 */
	generateTimetableHTML(lessons) {
		// Helper function to escape HTML
		const escapeHtml = (text) => {
			if (!text) {
				return '';
			}
			return String(text)
				.replace(/&/g, '&amp;')
				.replace(/</g, '&lt;')
				.replace(/>/g, '&gt;')
				.replace(/"/g, '&quot;')
				.replace(/'/g, '&#039;');
		};

		// Format current time
		const now = new Date();
		const timeStr = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

		// Build HTML
		let html = '<div class="edu-tt-container">';
		
		// Header with update time
		html += `<div class="edu-tt-header">Heute <span class="edu-tt-update">Stand: ${timeStr}</span></div>`;

		// Lessons
		if (lessons && lessons.length > 0) {
			lessons.forEach(lesson => {
				const period = escapeHtml(lesson.period || '');
				const subject = escapeHtml(lesson.subject || '');
				const startTime = escapeHtml(lesson.startTime || '');
				const room = escapeHtml(lesson.room || '');

				html += '<div class="edu-tt-row">';
				html += `<div class="edu-tt-period">${period}</div>`;
				html += '<div class="edu-tt-details">';
				html += `<div class="edu-tt-subject">${subject}</div>`;
				if (startTime) {
					html += `<div class="edu-tt-time">${startTime}</div>`;
				}
				html += '</div>';
				if (room) {
					html += `<div class="edu-tt-room">${room}</div>`;
				}
				html += '</div>';
			});
		} else {
			html += '<div class="edu-tt-empty">Keine Stunden heute</div>';
		}

		html += '</div>';
		return html;
	}

	/**
	 * Generate HTML for notifications visualization using absolute positioning
	 * @param {Array} notifications - Array of notification objects
	 * @returns {string} HTML string ready for VIS
	 */
	generateNotificationHTML(notifications) {
		// Helper function to escape HTML
		const escapeHtml = (text) => {
			if (!text) {
				return '';
			}
			return String(text)
				.replace(/&/g, '&amp;')
				.replace(/</g, '&lt;')
				.replace(/>/g, '&gt;')
				.replace(/"/g, '&quot;')
				.replace(/'/g, '&#039;');
		};

		// Helper function to convert newlines to <br>
		const convertNewlines = (text) => {
			if (!text) {
				return '';
			}
			return String(text).replace(/\n/g, '<br>');
		};

		// Helper function to extract date from notification (check both date and timestamp)
		const extractDate = (notification) => {
			// Try date first, then timestamp
			const dateValue = notification.date || notification.timestamp || null;
			if (!dateValue) {
				// Fallback to current date if neither exists
				return new Date();
			}
			try {
				return new Date(dateValue);
			} catch (e) {
				// If parsing fails, use current date
				return new Date();
			}
		};

		// Sort notifications by date descending (newest first)
		const sortedNotifications = [...notifications].sort((a, b) => {
			const dateA = extractDate(a);
			const dateB = extractDate(b);
			const timeA = dateA ? dateA.getTime() : 0;
			const timeB = dateB ? dateB.getTime() : 0;
			return timeB - timeA; // Descending (newest first)
		});

		// Format current time
		const now = new Date();
		const timeStr = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

		// Helper function to format date as DD.MM.
		const formatDate = (dateObj) => {
			if (!dateObj || !(dateObj instanceof Date) || isNaN(dateObj.getTime())) {
				return '';
			}
			const day = String(dateObj.getDate()).padStart(2, '0');
			const month = String(dateObj.getMonth() + 1).padStart(2, '0');
			return `${day}.${month}.`;
		};

		// Build HTML with absolute positioning
		let html = '<div style="position: relative; width: 100%; height: 100%; overflow: hidden; background: #1e1e1e; font-family: \'Segoe UI\', Arial, sans-serif;">';
		
		// Header (Fixed) - Absolute positioned
		html += '<div style="position: absolute; top: 0; left: 0; right: 0; height: 50px; background: #2d3436; color: #fff; padding: 0 15px; display: flex; align-items: center; justify-content: space-between; border-bottom: 1px solid #444; box-sizing: border-box; z-index: 10;">';
		html += '<span>🔔 Nachrichten</span>';
		html += `<span style="font-size: 11px; color: #ccc;">Stand: ${timeStr}</span>`;
		html += '</div>';

		// Content (Scrollable) - Absolute positioned
		html += '<div style="position: absolute; top: 50px; bottom: 0; left: 0; right: 0; overflow-y: auto; padding: 10px; box-sizing: border-box;">';

		// Notifications
		if (sortedNotifications && sortedNotifications.length > 0) {
			sortedNotifications.forEach(notification => {
				const sender = escapeHtml(notification.author || 'Unbekannt');
				const dateObj = extractDate(notification);
				const dateStr = formatDate(dateObj);
				const body = notification.text || '';

				// Card with green border (dark mode styling)
				html += '<div style="background-color: #2d3436; border-left: 4px solid #00b894; margin-bottom: 10px; padding: 12px; border-radius: 4px;">';
				
				// Meta section (sender and date)
				html += '<div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">';
				html += `<span style="font-size: 12px; font-weight: bold; color: #00b894;">${sender}</span>`;
				if (dateStr) {
					html += `<span style="font-size: 11px; color: #95a5a6;">${dateStr}</span>`;
				}
				html += '</div>';
				
				// Body text (with newlines converted to <br>)
				if (body) {
					const bodyEscaped = escapeHtml(body);
					const bodyWithBreaks = convertNewlines(bodyEscaped);
					html += `<div style="font-size: 14px; color: #ecf0f1; line-height: 1.4;">${bodyWithBreaks}</div>`;
				}
				
				html += '</div>';
			});
		} else {
			html += '<div style="text-align: center; padding: 40px 20px; color: #95a5a6; font-size: 16px;">Keine Nachrichten</div>';
		}

		html += '</div>'; // Close content
		html += '</div>'; // Close container
		return html;
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

			// Fetch timetables with error handling
			try {
				// Note: getTimetableForDate doesn't support passing student directly,
				// but the timetable is already filtered by the logged-in user/student context
				todayTimetable = await this.edupageClient.getTimetableForDate(today);
			} catch (error) {
				this.log.warn(`Failed to fetch today's timetable: ${error.message}`);
				todayTimetable = null;
			}

			try {
				nextSchoolDayTimetable = await this.edupageClient.getTimetableForDate(nextSchoolDay);
			} catch (error) {
				this.log.warn(`Failed to fetch next school day's timetable: ${error.message}`);
				nextSchoolDayTimetable = null;
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

			const timelineData = timeline
				.map(msg => {
					// Extract relevant data from Message objects
					return {
						id: msg.id,
						type: msg.type || null,
						text: msg.text || null,
						date: msg.date || null,
						timestamp: msg.timestamp || null,
						author: msg.author?.name || null
					};
				})
				.filter(msg => {
					// Filter out homework items
					if (msg.type === 'homework') {
						return false;
					}
					// Filter out items with null or empty text
					if (!msg.text || msg.text.trim() === '') {
						return false;
					}
					return true;
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

			// Extract teachers from timetable (source of truth)
			const teachersMap = new Map();
			
			// Collect teachers from today's timetable
			if (todayTimetable && todayTimetable.lessons) {
				todayTimetable.lessons.forEach(lesson => {
					if (lesson.teachers && Array.isArray(lesson.teachers)) {
						lesson.teachers.forEach(teacher => {
							const teacherName = teacher.name || (teacher.firstName && teacher.lastName ? `${teacher.firstName} ${teacher.lastName}` : null) || (teacher.firstname && teacher.lastname ? `${teacher.firstname} ${teacher.lastname}` : null);
							const subjectName = lesson.subject ? lesson.subject.name : null;
							if (teacherName && teacher.id) {
								if (!teachersMap.has(teacher.id)) {
									teachersMap.set(teacher.id, {
										id: teacher.id,
										name: teacherName,
										short: teacher.short || null,
										subjects: new Set()
									});
								}
								if (subjectName) {
									teachersMap.get(teacher.id).subjects.add(subjectName);
								}
							}
						});
					}
				});
			}
			
			// Collect teachers from next school day's timetable
			if (nextSchoolDayTimetable && nextSchoolDayTimetable.lessons) {
				nextSchoolDayTimetable.lessons.forEach(lesson => {
					if (lesson.teachers && Array.isArray(lesson.teachers)) {
						lesson.teachers.forEach(teacher => {
							const teacherName = teacher.name || (teacher.firstName && teacher.lastName ? `${teacher.firstName} ${teacher.lastName}` : null) || (teacher.firstname && teacher.lastname ? `${teacher.firstname} ${teacher.lastname}` : null);
							const subjectName = lesson.subject ? lesson.subject.name : null;
							if (teacherName && teacher.id) {
								if (!teachersMap.has(teacher.id)) {
									teachersMap.set(teacher.id, {
										id: teacher.id,
										name: teacherName,
										short: teacher.short || null,
										subjects: new Set()
									});
								}
								if (subjectName) {
									teachersMap.get(teacher.id).subjects.add(subjectName);
								}
							}
						});
					}
				});
			}
			
			// Convert to array and sort
			const teachersList = Array.from(teachersMap.values())
				.map(teacher => ({
					id: teacher.id,
					name: teacher.name,
					short: teacher.short,
					subjects: Array.from(teacher.subjects).sort()
				}))
				.sort((a, b) => {
					const nameA = a.name || '';
					const nameB = b.name || '';
					return nameA.localeCompare(nameB);
				});

			this.log.debug(`Found ${teachersList.length} unique teachers from timetable`);

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

			// Save pending and completed homeworks (clear if empty)
			const pendingJson = JSON.stringify(pendingHomeworks.length > 0 ? pendingHomeworks : []);
			const completedJson = JSON.stringify(completedHomeworks.length > 0 ? completedHomeworks : []);
			await this.setState('data.homework.pending_json', { val: pendingJson, ack: true });
			await this.setState('data.homework.completed_json', { val: completedJson, ack: true });

			// Generate and save HTML for VIS
			const homeworkHTML = this.generateHomeworkHTML(pendingHomeworks, completedHomeworks);
			await this.setState('data.homework.vis_html', { val: homeworkHTML, ack: true });

			// Save notifications data (legacy states for backward compatibility)
			const notificationsJson = JSON.stringify(timelineData);
			await this.setState('data.notifications_json', { val: notificationsJson, ack: true });
			await this.setState('data.notifications_count', { val: timeline.length, ack: true });

			// Save today's and all notifications
			const todayNotificationsJson = JSON.stringify(todayNotifications);
			await this.setState('data.notifications.today_json', { val: todayNotificationsJson, ack: true });
			await this.setState('data.notifications.all_json', { val: notificationsJson, ack: true });

			// Generate and save HTML for notifications
			const notificationHTML = this.generateNotificationHTML(timelineData);
			await this.setState('data.notifications.vis_html', { val: notificationHTML, ack: true });

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
						room: lesson.classrooms && lesson.classrooms.length > 0
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
						room: lesson.classrooms && lesson.classrooms.length > 0
							? lesson.classrooms.map(c => c.name || c.toString()).join(', ')
							: null,
						date: lesson.date ? lesson.date.toISOString().split('T')[0] : null
					};
				});
			}

			// Save general info (clear if empty)
			await this.setState('info.student_name', { val: extractedStudentName || '', ack: true });
			await this.setState('info.teachers_json', { val: JSON.stringify(teachersList.length > 0 ? teachersList : []), ack: true });
			await this.setState('info.classes_json', { val: JSON.stringify(classesList.length > 0 ? classesList : []), ack: true });

			// Save timetable data (clear if empty)
			await this.setState('data.classes.today_json', { val: JSON.stringify(todayLessons.length > 0 ? todayLessons : []), ack: true });
			await this.setState('data.classes.tomorrow_json', { val: JSON.stringify(nextSchoolDayLessons.length > 0 ? nextSchoolDayLessons : []), ack: true });

			// Generate and save HTML for timetable
			const timetableHTML = this.generateTimetableHTML(todayLessons);
			await this.setState('data.classes.today_html', { val: timetableHTML, ack: true });

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
