const UserAdapter = require('vialer-js/bg/plugins/user/adapter')

class UserAdapterVoipgrid extends UserAdapter {
    constructor(app) {
        super(app)

        this.app.on('bg:user:update-token', async({callback}) => {
            await this._platformData()
            callback({token: this.app.state.user.platform.tokens.portal})
        })
    }


    /**
    * Format an account from the VoIPGRID API
    * to an internally used format.
    */
    _formatAccount(account) {
        let option = {
            id: account.id,
            name: `${account.internal_number} - ${account.description}`,
            uri: `sip:${account.account_id}@voipgrid.nl`,
            username: account.account_id,
        }

        if (account.password) option.password = account.password
        return option
    }


    _initialState() {
        return {
            platform: {
                account: {
                    id: null,
                    password: null,
                    username: null,
                    selection: true,
                },
                tokens: {
                    portal: null,
                    sip: null,
                },
            },
            token: null,
            twoFactor: false,
        }
    }


    /**
    * Retrieve the autologin token for the user. This token is
    * used to login automatically when the user opens a link
    * to the vendor portal.
    */
    _platformData() {
        return new Promise(async(resolve, reject) => {
            let res
            try {
                res = await this.app.api.client.get('api/autologin/token/')
            } catch (err) {
                return reject(err)
            }

            this.app.setState({user: {platform: {tokens: {portal: res.data.token}}}})
            this.app.logger.info(`${this}(re)loaded autologin token`)
            resolve()
        })
    }


    /**
    * Make an api call with the current basic authentication to retrieve
    * profile information with. Save the credentials in storage when the call
    * is succesful, otherwise remove the credentials from the store.
    * @param {object} options - Options to pass.
    * @param {String} options.username - Email address to login with.
    * @param {String} options.password - Password to login with.
    * @param {String} [options.token] - A 2fa token to login with.
    */
    async login({callback, username, password, token}) {
        this.app.setState({user: {status: 'login'}})

        let apiParams, res

        if (token) apiParams = {email: username, password, two_factor_token: token}
        else apiParams = {email: username, password}

        res = await this.app.api.client.post('api/permission/apitoken/', apiParams)

        // A login failure. Give the user feedback about what went wrong.
        if (this.app.api.NOTOK_STATUS.includes(res.status)) {
            let message
            if (res.data.apitoken) {
                if (res.data.apitoken.email || res.data.apitoken.password) {
                    message = this.app.$t('failed to login; please check your credentials.')
                    this.app.notify({icon: 'warning', message, type: 'warning'})
                } else if (res.data.apitoken.two_factor_token) {
                    const validationMessage = res.data.apitoken.two_factor_token[0]
                    if (validationMessage === 'this field is required') {
                        // Switch two-factor view.
                        this.app.setState({user: {twoFactor: true}})
                    } else if (validationMessage === 'invalid two_factor_token') {
                        message = this.app.$t('invalid two factor token. Please check your tokenizer.')
                        callback({message, valid: false})
                    }
                }
            } else if (res.data.error) {
                if (res.data.error.message.includes('Te veel')) {
                    // We only need the time to keep the message clear.
                    const retryTime = res.data.error.message.split(' ').pop()
                    message = this.app.$t('too many failed login attempts - wait until {date}', {date: retryTime})
                    this.app.notify({icon: 'warning', message, type: 'warning'})
                }
            }
            this.app.setState({user: {status: null}})
            return
        }

        this.app.api.setupClient(username, res.data.api_token)
        const _res = await this.app.api.client.get('api/plugin/user/')

        // Do some checks for user validity.
        if (_res.status === 401) {
            //Logout partner users. Only platform client users are able to use
            // VoIPGRID platform telephony features.
            const message = this.app.$t('a partner user cannot be used to login with.')
            this.app.changeSession(null, {app: {notifications: [{icon: 'settings', message, type: 'warning'}]}})
            return
        } else if (_res.data === 'You need to change your password in the portal') {
            this.app.notify({icon: 'settings', message: this.app.$t('You need to change your password in the portal.'), type: 'warning'})
            return
        }

        // TODO: Replace hardcoded fields with data from API.
        console.log("LOGIN", _res.data)
        _res.data.client_id = 540111
        _res.data.id = 500911

        let userFields = {
            client_id: _res.data.client_id,
            id: _res.data.id,
            platform: {
                account: {
                    username,
                    password: _res.data.token,
                    uri: `sip:${username}`
                }
            },
            realName: [
                _res.data.first_name,
                _res.data.preposition,
                _res.data.last_name
            ].filter((i) => i !== '').join(' '),
            token: res.data.api_token,
        }

        this.app.logger.info(`${this}${username} authenticated successfully`)

        if (this.app.state.app.session.active !== username) {
            // State is reinitialized, but we are not done loading yet.
            let keptState = {user: {status: 'login'}}
            await this.app.changeSession(username, keptState)
        }

        await super.login({username, password, userFields})
        const selected = _res.data.selected_account
        if (selected) {
            await this.app.setState({settings: {webrtc: {account: {selected: this._formatAccount(selected)}, enabled: true}}}, {persist: true})
        } else {
            this.app.logger.info(`${this}no account set; use ConnectAB account info`)
            await this.app.setState({settings: {webrtc: {account: {selected: userFields.platform.account}}}}, {persist: true})
        }

        this.app.setState({user: {status: null}})
        this.app.__initServices(false)
    }


    /**
    * Generate a representational name for this module. Used for logging.
    * @returns {String} - An identifier for this module.
    */
    toString() {
        return `${this.app}[adapter-user-vg] `
    }
}

module.exports = UserAdapterVoipgrid
