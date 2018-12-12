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

            if (res.status == 401) {
                // Logout.
                this.app.changeSession(null)
            }

            this.app.setState({user: {platform: {tokens: {portal: res.data.token}}}})
            this.app.logger.info(`${this}(re)loaded autologin token`)
            resolve()
        })
    }


    /**
    * Handles changing the account and signals when the new account info
    * is loaded, by responding with the *complete* account credentials in
    * the callback.
    * @param options - options to pass.
    * @param options.accountId - Id of an account from options to set.
    * @param options.callback - Callback to the original emitting event.
    */
    async _selectAccount({accountId, callback}) {
        this.app.logger.info(`${this}select account ${accountId}`)
        let account = this.app.state.settings.webrtc.account
        if (accountId) {
            const res = await this.app.api.client.put('api/plugin/user/selected_account/', {id: accountId})
            // Setting a plugin account may fail. Notify the user
            // that an error occured.
            if (res.status === 400) {
                const message = `${this.app.$t('unexpected error')}!`
                this.app.notify({
                    icon: 'github',
                    link: {
                        url: 'https://github.com/vialer/vialer-js/issues',
                        text: `${this.app.$t('more info')}...`,
                    },
                    message, type: 'warning', timeout: 0})
                return
            }

            account.selected = this._formatAccount(res.data)
            account.using = this._formatAccount(res.data)
        } else {
            account.using = this.app.state.settings.webrtc.account.fallback
        }

        account.status = null

        await this.app.setState({
            settings: {
                webrtc: {
                    account,
                    enabled: accountId ? true : false,
                },
            },
        }, {persist: true})
        callback({account: account.selected})
    }


    /**
    * Make an api call with the current basic authentication to retrieve
    * profile information with. Save the credentials in storage when the call
    * is succesful, otherwise remove the credentials from the store.
    * @param {object} options - Options to pass.
    * @param {Function} options.callback - Callback.
    * @param {String} options.username - Email address to login with.
    * @param {String} options.password - Password to login with.
    * @param {String} [options.token] - A 2FA token to login with.
    */
    async login({callback, username, password, token}) {
        this.app.setState({user: {status: 'login'}})

        let apiParams, res

        if (token) apiParams = {email: username, password, two_factor_token: token}
        else apiParams = {email: username, password}

        res = await this.app.api.client.post('api/permission/apitoken/', apiParams)

        // A login failure. Give the user feedback about what went wrong.
        if (!this.app.api.OK_STATUS.includes(res.status)) {
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
                        callback({twoFactor: true, valid: false})
                    } else {
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

        if (callback) {
            callback({valid: true})
        }

        this.app.api.setupClient(username, res.data.api_token)
        const _res = await this.app.api.client.get('api/plugin/user/')

        // Do some checks for user validity.
        if (_res.status === 401) {
            // Only platform client users are able to use VoIPGRID
            // platform telephony features.
            const message = this.app.$t('a partner user cannot be used to login with.')
            this.app.changeSession(null, {app: {notifications: [{icon: 'settings', message, type: 'warning'}]}})
            return
        } else if (_res.data === 'You need to change your password in the portal') {
            this.app.notify({icon: 'settings', message: this.app.$t('please change your {name} password first.', {
                name: this.app.state.app.vendor.portal.name,
            }), type: 'warning'})

            this.app.helpers.openWindow({
                focused: false,
                height: 550,
                type: 'panel',
                url: this.app.state.settings.platform.url,
                width: 450,
            })

            this.app.setState({user: {status: null}})
            return
        }

        let userFields = {
            client_id: _res.data.client_id,
            id: _res.data.systemuser_id,
            realName: [_res.data.first_name, _res.data.preposition, _res.data.last_name].filter((i) => i !== '').join(' '),
            token: res.data.api_token,
        }

        this.app.logger.info(`${this}authenticated successfully.`)

        if (this.app.state.app.session.active !== username) {
            // State is reinitialized, but we are not done loading yet.
            let keptState = {user: {status: 'login'}}
            await this.app.changeSession(username, keptState)
        }

        await super.login({username, password, userFields})

        let selectedAccount = this.app.state.settings.webrtc.account.selected
        let accountConnectAB = {
            name: username,
            username,
            password: _res.data.token,
            uri: `sip:${username}`
        }
        // No account selected yet.
        if (!selectedAccount.username || !selectedAccount.password) {
            this.app.logger.info(`${this}set account default to connectAB`)
            await this.app.setState({settings: {webrtc: {account: {
                fallback: accountConnectAB,
                selected: accountConnectAB}}}
            }, {persist: true})
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
