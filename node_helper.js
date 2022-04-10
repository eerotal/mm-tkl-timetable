var fs = require("fs");
var path = require("path");
var moment = require("moment");
var NodeHelper = require("node_helper");
var URL = require('url');
var https = require('https');

function getSchedule(baseUrl, stop, successCb, errorCB) {
	const payload = getTKLPayload(stop.id || stop, moment().format("YYYYMMDD"));
	const options = {
		method: "POST",
		headers: {
			"Content-Type": "application/graphql",
			"Content-Length": payload.length
		},
	};

	let req = https.request(baseUrl, options, res => {
		let body = "";

		res.on("data", (chunk) => {
			body += chunk;
		});

		res.on("end", () => {
			if (body.indexOf('<') === 0) {
				errorCB(err);
				return;
			}

			try {
				let json = JSON.parse(body);
				const data = json.data.stop;

				if (!data) {
					errorCB(new Error("Invalid data received from API."));
					return;
				}

				let response = {
					stop: stop.id || stop,
					name: stop.name || data.name,
					busses: processBusData(data.stoptimesForServiceDate, stop.minutesFrom)
				};

				successCb(response);
			} catch (e) {
				errorCB(e)
			}
		});
	});

	req.on("error", e => {
		errorCB(e)
	});

	req.write(payload);
	req.end();
}

function getTKLPayload(stop, date) {
	return `{
      stop(id: "tampere:${stop}") {
        name
        lat
        lon
        url
        stoptimesForServiceDate(date:"${date}") {
          pattern {
            name
            route {
              shortName
            }
          }
          stoptimes {
            serviceDay
            headsign
            scheduledDeparture
            realtimeDeparture
            trip {
              serviceId
              alerts {
                alertHeaderText
              }
            }
          }
        }
      }
  }`;
}

function processBusData(json, minutesFrom = 0) {
	let times = [];
	json.forEach(value => {
		const line = value.pattern.route.shortName;
		value.stoptimes.forEach(stopTime => {
			// times in seconds so multiple by 1000 for ms
			let datVal = new Date(
				(stopTime.serviceDay + stopTime.realtimeDeparture) * 1000
			);
			if (datVal.getTime() < new Date().getTime() + (minutesFrom * 60 * 1000)) {
				return;
			}
			const date = moment(datVal);
			const headsign = stopTime.headsign;
			const bus = {
				line,
				headsign,
				info: stopTime.trip.alerts.join(),
				time: date.format("H:mm"),
				until: date.fromNow(),
				ts: datVal.getTime()
			};
			times.push(bus);
		});
	});
	times.sort((a, b) => a.ts - b.ts);
	return times;
}

module.exports = NodeHelper.create({
	config: {},
	updateTimer: null,
	start: function () {
		moment.locale(config.language || "fi");
	},

	socketNotificationReceived: function (notification, payload) {
		if (notification === "CONFIG") {
			this.config = payload;
			this.scheduleNextFetch(this.config.initialLoadDelay);
		}
	},

	fetchTimetables() {
		var self = this;
		this.config.stops.forEach(stop => {
			getSchedule(
				this.config.apiURL,
				stop,
				data => {
					self.sendSocketNotification("TIMETABLE", data);
					self.scheduleNextFetch(this.config.updateInterval);
				},
				err => {
					console.error(err);
					self.scheduleNextFetch(this.config.retryDelay);
				}
			);
		});
	},

	scheduleNextFetch: function (delay) {
		if (typeof delay === "undefined") {
			delay = 60 * 1000;
		}

		var self = this;
		clearTimeout(this.updateTimer);
		this.updateTimer = setTimeout(function () {
			self.fetchTimetables();
		}, delay);
	}
});
