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
                    fallback: {
                        id: null,
                        password: null,
                        username: null,
                    },
                    selected: {
                        // A selected account may not be the actual *used*
                        // account at that moment when the fallback account
                        // is used. This is just a reference to the previously
                        // set account option, so we can restore it when
                        // re-enabling webrtc again.
                        id: null,
                    },
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
    * Handles changing the account and signals the when this is done
    * by responding with the *complete* account credentials in
    * the callback.
    */
    async _selectAccount({account, callback}) {
        this.app.logger.info(`${this}switching to new account: ${account.id}`)
        // New API call:
        // const res = await this.app.api.client.put('api/plugin/user/selected_account/', {id: account.id})
        // account = this.app.plugins.user.adapter._formatAccount(account)
        this.app.setState({
            settings: {webrtc: {account: {selected: account}}},
            user: {platform: {account: {selected: {id: account.id}}}},
        }, {persist: true})
        callback({account})
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
        const _res = await this.app.api.client.get('api/permission/systemuser/profile/')

        if (!_res.data.client) {
            //Logout partner users. Only platform client users are able to use
            // VoIPGRID platform telephony features.
            this.logout()
            this.app.notify({icon: 'settings', message: this.app.$t('this type of user is invalid.'), type: 'warning'})
            return
        }
        let userFields = {
            client_id: _res.data.client.replace(/[^\d.]/g, ''),
            id: _res.data.id,
            platform: {
                account: {
                    fallback: {
                        username,
                        password: _res.data.token,
                        uri: `sip:${username}`
                    },
                },
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

        let selectedAccount = this.app.state.settings.webrtc.account.selected
        // No account selected yet.
        if (!selectedAccount.username || !selectedAccount.password) {
            this.app.logger.info(`${this}no account set; use ConnectAB account info`)
            await this.app.setState({settings: {webrtc: {account: {selected: userFields.platform.account.fallback}}}}, {persist: true})
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
