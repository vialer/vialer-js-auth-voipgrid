const UserProvider = require('vialer-js/src/js/bg/modules/user/provider')

class UserProviderVoipgrid extends UserProvider {
    constructor(app) {
        super(app)

        this.app.on('bg:user:update-token', async({callback}) => {
            await this._platformData()
            callback({token: this.app.state.user.platform.tokens.portal})
        })
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
    async _platformData() {
        const res = await this.app.api.client.get('api/autologin/token/')
        this.app.setState({user: {platform: {tokens: {portal: res.data.token}}}})
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
        if (this.app.state.app.session.active !== username) this.app.setSession(username)
        this.app.setState({user: {status: 'loading'}})

        let apiParams
        if (token) apiParams = {email: username, password, two_factor_token: token}
        else apiParams = {email: username, password}

        const res = await this.app.api.client.post('api/permission/apitoken/', apiParams)
        // A login failure. Give the user feedback about what went wrong.
        if (this.app.api.NOTOK_STATUS.includes(res.status)) {
            this.app.setState({user: {status: null}})
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
            }
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
            platform: {tokens: {sip: _res.data.token}},
            realName: [
                _res.data.first_name,
                _res.data.preposition,
                _res.data.last_name
            ].filter((i) => i !== '').join(' '),
            token: res.data.api_token,
        }

        super.login({username, password, userFields})
    }
}

module.exports = UserProviderVoipgrid
