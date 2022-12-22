const net = require('net')
const request = require('request-promise')
const Promise = require('bluebird')
const syrup = require('@devicefarmer/stf-syrup')
const logger = require('../../../../util/logger')
const iosutil = require('../util/iosutil')
const wireutil = require('../../../../wire/util')
const wire = require('../../../../wire')
const lifecycle = require('../../../../util/lifecycle')

const LOG_REQUEST_MSG = 'Request has been sent to WDA with data: '

module.exports = syrup.serial()
  .dependency(require('../devicenotifier'))
  .dependency(require('../../support/push'))
  .define((options, notifier, push) => {
    const log = logger.createLogger('wdaClient')
    log.info('WdaClient.js initializing...')

    const socket = new net.Socket()
    let retryingConnectToSocket = false
    const reConnectTimeout = 3000
    const reConnectMaxAttempts = 5
    let reConnectAttemptNumber = 0
    const WdaClient = {
      baseUrl: iosutil.getUri(options.wdaHost, options.wdaPort),

      sessionId: null,
      deviceSize: null,
      touchDownParams: {},
      isMove: false,
      tapStartAt: 0,

      startSession: function() {
        let params = {
          capabilities: {}
        }

        return new Promise((resolve, reject) => {
          log.info("verifying wda session status...")
          // parse '/status' response to detect existing WDA session if any (appium/automation)
          /*
          {
            "value" : {
              "message" : "WebDriverAgent is ready to accept commands",
              "state" : "success",
              "os" : {
                "testmanagerdVersion" : 28,
                "name" : "iOS",
                "sdkVersion" : "15.0",
                "version" : "14.7.1"
              },
              "ios" : {
                "ip" : "192.168.89.165"
              },
              "ready" : true,
              "build" : {
                "time" : "Nov 29 2021 12:56:15",
                "productBundleIdentifier" : "com.facebook.WebDriverAgentRunner"
              }
            },
            "sessionId" : "10D6A1DF-1FD8-4FC1-93ED-0789F1DBB6D4"
          }
          */

          this.handleRequest({
            method: 'GET',
            uri: `${this.baseUrl}/status`,
            json: true
          })
            .then(response => {
              log.info("status response: " + JSON.stringify(response))
              if (response.sessionId != null) {
                this.sessionId = response.sessionId
                log.info("reusing existing wda session: " + this.sessionId)
                return this.size()
              } else {
                // #285 as no existing session detected press home button to unlock device and activate default springboard screen
                this.homeBtn()

                log.info("starting wda session...")
                this.handleRequest({
                  method: 'POST',
                  uri: `${this.baseUrl}/session`,
                  body: params,
                  json: true
                })
                  .then(response => {
                    log.info("startSession response: " + JSON.stringify(response))
                    // {"value":{"sessionId":"C4A07D30-E2E2-4922-9829-2B3ED2C4DBAE",
                    //    "capabilities":{"device":"iphone","browserName":" ","sdkVersion":"14.7.1","CFBundleIdentifier":"com.apple.springboard"}},
                    //    "sessionId":"C4A07D30-E2E2-4922-9829-2B3ED2C4DBAE"}

                    push.send([
                      wireutil.global,
                      wireutil.envelope(new wire.SdkIosVersion(
                        options.serial,
                        response.value.capabilities.device,
                        response.value.capabilities.sdkVersion
                      ))
                    ])
                    this.sessionId = response.sessionId
                    // #284 send info about battery to STF db
                    log.info('sessionId: ' + this.sessionId)
                    this.batteryIosEvent()
                      .then(response => {
                        let status = "-"
                        if (response.value.state == 3) {status="full"}
                        if (response.value.state == 2) {status="charging"}
                        push.send([
                          wireutil.global,
                          wireutil.envelope(new wire.BatteryIosEvent(
                            options.serial,
                            "good",
                            "usb",
                            status,
                            parseInt(response.value.level * 100),
                            "n/a ",
                            100
                          ))
                        ])
                      }).catch(err => log.info(err))

                    return this.size()

                  })
                  .catch(err => {
                    log.error('"startSession" No valid response from web driver!', err)
                    return reject(err)
                  })
              }
            })
        })
      },
      stopSession: function() {
        log.info('stopping wda session...')
        let currentSessionId = this.sessionId
        this.sessionId = null
        return this.handleRequest({
          method: 'DELETE',
          uri: `${this.baseUrl}/session/${currentSessionId}`
        })
          .then(function(res) {
            // close socket on success disconnect
            disconnectFromWdaMjpeg()

            return res
          })
      },
      typeKey: function(params) {
        if (!params.value || !params.value[0]) {
          return
        }
        log.verbose("typeKeys: " + params.value)

        return new Promise((resolve, reject) => {
          // #253 get active app info to skip type for springboard!
          this.handleRequest({
            method: 'GET',
            uri: `${this.baseUrl}/wda/activeAppInfo`,
            json: true
          })
            .then(response => {
              let bundleId = response.value.bundleId
              log.verbose("active app: " + bundleId)
              if (bundleId == 'com.apple.springboard') {
                // cancel typing to ignore all the rest requets/responses...
                throw new Error('ignoring typeKey as springboard is active!')
              }
              // get active element to send keys directly into it
              return this.handleRequest({
                method: 'GET',
                uri: `${this.baseUrl}/session/${this.sessionId}/element/active`,
                json: true
              })
            })
            .then(response => {
              const {ELEMENT} = response.value
              log.verbose("active element: " + ELEMENT)
              return this.handleRequest({
                method: 'POST',
                uri: `${this.baseUrl}/session/${this.sessionId}/element/${ELEMENT}/value`,
                body: params,
                json: true
              })
            })
            .catch(err => {
              if (err.statusCode === 404) {
                log.verbose("as no active element discovered type keys using old slow method: " + params.value)
                try {
                  return this.handleRequest({
                    method: 'POST',
                    uri: `${this.baseUrl}/session/${this.sessionId}/wda/keys`,
                    body: params,
                    json: true
                  })
                } catch(e) {
                  log.error(e)
                }
              }
              else {
                log.error(err)
              }
            })
        })
      },
      tap: function(params) {
        this.tapStartAt = (new Date()).getTime()
        this.touchDownParams = params
        this.isMove = false
      },
      homeBtn: function() {
        return this.handleRequest({
          method: 'POST',
          uri: `${this.baseUrl}/wda/homescreen`
        })
      },
      setScaleByRotation: function(params, deviceSize) {
        return iosutil.swipe(this.orientation, params, deviceSize)
      },
      swipe: function(params) {
        const scale = this.setScaleByRotation(params, this.deviceSize)
        this.isMove = true
        return this.handleRequest({
          method: 'POST',
          uri: `${this.baseUrl}/session/${this.sessionId}/wda/dragfromtoforduration`,
          body: scale,
          json: true
        })
      },
      touchUp: function() {
        if(!this.isMove) {
          const {x, y} = this.touchDownParams
          let params = {
            x: x * this.deviceSize.width,
            y: y * this.deviceSize.height
          }

          if(((new Date()).getTime() - this.tapStartAt) <= 1000 || !this.tapStartAt) {
            return this.handleRequest({
              method: 'POST',
              uri: `${this.baseUrl}/session/${this.sessionId}/wda/tap/0`,
              body: params,
              json: true
            })
          } else {
            return this.handleRequest({
              method: 'POST',
              uri: `${this.baseUrl}/session/${this.sessionId}/wda/touchAndHold`,
              body: Object.assign(params, {duration: 1}),
              json: true
            })
          }
        }
      },
      tapDeviceTreeElement: function(message) {
        const params = {
          using: 'link text',
          value: 'label=' + message.label,
        }

        return new Promise((resolve, reject) => {
          this.handleRequest({
            method: 'POST',
            uri: `${this.baseUrl}/session/${this.sessionId}/elements`,
            body: params,
            json: true
          })
            .then(response => {
              const {ELEMENT} = response.value[0]
              return this.handleRequest({
                method: 'POST',
                uri: `${this.baseUrl}/session/${this.sessionId}/element/${ELEMENT}/click`,
                body: {},
                json: true
              })
            })
            .catch(err => {
              log.error(err)
            })
        })
      },
      doubleClick: function() {
        if(!this.isMove) {
          const {x, y} = this.touchDownParams
          const params = {
            x: x * this.deviceSize.width,
            y: y * this.deviceSize.height
          }

          return this.handleRequest({
            method: 'POST',
            uri: `${this.baseUrl}/session/${this.sessionId}/wda/doubleTap`,
            body: params,
            json: true
          })
        }
      },
      size: function() {
        log.info("getting device window size...")

        return new Promise((resolve, reject) => {
          this.handleRequest({
            method: 'GET',
            uri: `${this.baseUrl}/session/${this.sessionId}/window/size`
          })
            .then(response => {
              try {
                this.deviceSize = JSON.parse(response).value
                let height = this.deviceSize.height
                let width = this.deviceSize.width

                this.handleRequest({
                  method: 'GET',
                  uri: `${this.baseUrl}/session/${this.sessionId}/wda/screen`
                })
                  .then(response => {
                    let scale = JSON.parse(response).value.scale
                    height = height * scale
                    width = width * scale

                    push.send([
                      wireutil.global,
                      wireutil.envelope(new wire.SizeIosDevice(
                        options.serial,
                        height,
                        width
                      ))
                    ])
                    return resolve(this.deviceSize)
                  })
              }
              catch (e) {
                return reject(new Error('Failed to parse json object'))
              }
            })
            .catch(err => {
              return reject(err)
            })
        })
      },
      openUrl: function(message) {
        const params = {
          url: message.url
        }

        return this.handleRequest({
          method: 'POST',
          uri: `${this.baseUrl}/session/` + this.sessionId + `/url`,
          body: params,
          json: true
        })
      },
      screenshot: function() {
        return new Promise((resolve, reject) => {
          this.handleRequest({
            method: 'GET',
            uri: `${this.baseUrl}/screenshot`,
            json: true
          })
            .then(response => {
              try {
                resolve(response)
              } catch(e) {
                reject(e)
              }
            })
            .catch(err => reject(err))
        })
      },
      rotation: function(params) {
        this.orientation = params.orientation

        return this.handleRequest({
          method: 'POST',
          uri: `${this.baseUrl}/session/${this.sessionId}/orientation`,
          body: params,
          json: true
        })
      },
      batteryIosEvent: function() {
        return this.handleRequest({
          method: 'GET',
          uri: `${this.baseUrl}/session/${this.sessionId}/wda/batteryInfo`,
          json: true
        })
      },
      getTreeElements: function() {
        return this.handleRequest({
          method: 'GET',
          uri: `${this.baseUrl}/source?format=json`,
          json: true
        })
      },
      pressButton: function(params) {
        return this.handleRequest({
          method: 'POST',
          uri: `${this.baseUrl}/session/${this.sessionId}/wda/pressButton`,
          body: {
            name: params
          },
          json: true
        })
      },
      appActivate: function(params) {
        return this.handleRequest({
          method: 'POST',
          uri: `${this.baseUrl}/session/${this.sessionId}/wda/apps/activate`,
          body: {
            bundleId: params
          },
          json: true
        })
      },
      pressPower: function() {
        return this.handleRequest({
          method: 'GET',
          uri: `${this.baseUrl}/session/${this.sessionId}/wda/locked`,
          json: true
        })
          .then(response => {
            let url = ''
            if(response.value === true) {
              url = `${this.baseUrl}/session/${this.sessionId}/wda/unlock`
            } else {
              url = `${this.baseUrl}/session/${this.sessionId}/wda/lock`
            }
            return this.handleRequest({
              method: 'POST',
              uri: url,
              json: true
            })
          })
      },
      handleRequest: function(requestOpt) {
        return new Promise((resolve, reject) => {
          request(requestOpt)
            .then(response => {
              log.verbose(LOG_REQUEST_MSG, JSON.stringify(requestOpt))
              return resolve(response)
            })
            .catch(err => {
              // #409: capture wda/appium crash asap and exit with status 1 from stf
              notifier.setDeviceTemporaryUnavialable(err)
              notifier.setDeviceAbsent(err)
              lifecycle.fatal(err) // exit with error code 1 is the best way to activate valid auto-healing steps with container(s) restart
            })
        })
      },
    }


    /*
     * WDA MJPEG connection is stable enough to be track status wda server itself.
     * As only connection is closed or error detected we have to restart STF
    */
    function connectToWdaMjpeg() {
      console.log('connecting to WdaMjpeg')
      socket.connect(options.connectPort, options.wdaHost)
    }

    function wdaMjpegConnectEventHandler() {
      console.log(`Connected to WdaMjpeg ${options.wdaHost}:${options.connectPort}`)
      retryingConnectToSocket = false
      reConnectAttemptNumber = 0
    }

    function handleWdaMjpegReconnection(error) {
      if (retryingConnectToSocket && reConnectAttemptNumber <= reConnectMaxAttempts) {
        reConnectAttemptNumber += 1
        setTimeout(connectToWdaMjpeg, reConnectTimeout)
      }
      else {
        // Looks like device was disconnected or wda errored
        if (error) {
          notifier.setDeviceAbsent(error)
          lifecycle.fatal(error)
        }
        else {
          lifecycle.fatal('wda connection is lost')
        }
      }
    }

    function wdaMjpegCloseEventHandler() {
      console.log('WdaMjpeg connection was closed')
      notifier.setDeviceAbsent('WdaMjpeg connection is lost')
      retryingConnectToSocket = true
      handleWdaMjpegReconnection()
    }

    function wdaMjpegEndEventHandler() {
      console.log('WdaMjpeg connection was ended')
      retryingConnectToSocket = true
      handleWdaMjpegReconnection()
    }

    function wdaMjpegErrorEventHandler(error) {
      console.log('WdaMjpeg connection errored')
      retryingConnectToSocket = true
      handleWdaMjpegReconnection(error)
    }

    function disconnectFromWdaMjpeg(error) {
      // closes socket by sending a FIN packet. It is possible the server will still send some data.
      socket.end()
      // completely closes socket (necessary only in case of errors)
      // socket.destroy(error)
    }

    socket.on('connect', wdaMjpegConnectEventHandler)
    socket.on('close', wdaMjpegCloseEventHandler)
    socket.on('end', wdaMjpegEndEventHandler)
    socket.on('error', wdaMjpegErrorEventHandler)
    connectToWdaMjpeg(options)

    return WdaClient
  })
