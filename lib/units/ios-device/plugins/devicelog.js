const syrup = require('@devicefarmer/stf-syrup')
const wire = require('../../../wire')
const wireutil = require('../../../wire/util')
const {spawn} = require('child_process')
const Promise = require('bluebird')
const dbapi = require('../../../db/api')

module.exports = syrup
  .serial()
  .dependency(require('../support/push'))
  .dependency(require('../support/router'))
  .dependency(require('../support/sub'))
  .dependency(require('./group'))

  .define(function(options, push, router, group) {
    let launchArgs = [
      '--udid',
      options.serial
    ]
    let DeviceLogger = {
      appOptions: {},
      channel: '',
      stream: null,
      setChannel: channel => {
        this.channel = channel
      },
      startLoggging: function(channel, deviceData) {
        let Logger = this
        Logger.channel = channel
        if (
          deviceData &&
          deviceData !== null
        ) {
          group.get().then(group => {
            launchArgs.push(deviceData.bundleName)
            Logger.stream = spawn('ios syslog', launchArgs, {
              shell: true
            })

            Logger.stream.stdout.on('data', data => {
              push.send([
                group.group,
                wireutil.envelope(
                  new wire.DeviceLogcatEntryMessage(
                    options.serial,
                    new Date().getTime() / 1000,
                    this.stream.pid,
                    this.stream.pid,
                    1,
                    'device:log:cat',
                    data.toString()
                  )
                )
              ])
            })

            Logger.stream.on('close', err => {
              //@TODO add handler fow closing event
              // Logger.killLoggingProcess()
            })
          })
        }
      },
      killLoggingProcess: () => {
        if(this.stream) {
          process.kill(-this.stream.pid)
          this.stream.kill()
          this.stream = null
          this.channel = ''
        }
      }
    }

    group.on('leave', DeviceLogger.killLoggingProcess)

    router
      .on(wire.LogcatStartMessage, function(channel, message) {
        let reply = wireutil.reply(options.serial)
        DeviceLogger.startLoggging(channel)
        push.send([channel, reply.okay('success')])
      })
      .on(wire.LogcatStopMessage, function(channel, data) {
        DeviceLogger.killLoggingProcess()
      })
      .on(wire.GroupMessage, function(channel, data) {
        DeviceLogger.channel = channel
      })


    return Promise.resolve()
  })
