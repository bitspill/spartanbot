import RentalProvider from './RentalProvider'
import MiningRigRentals from 'miningrigrentals-api-v2'

/**
 * A Rental Provider for MiningRigRentals
 */
class MRRProvider extends RentalProvider {
	/**
	 * Create a new MRR Provider
	 * @param  {Object} settings - Settings for the RentalProvider
	 * @param {String} settings.api_key - The API Key for the Rental Provider
	 * @param {String} settings.api_secret - The API Secret for the Rental Provider
	 * @param {String} [settings.uid] - The unique identifier for this Rental Provider
	 * @return {MRRProvider}
	 */
	constructor(settings){
		super(settings)

		this.api = new MiningRigRentals({key: this.api_key, secret: this.api_secret})
	}

	/**
	 * Get the "type" of this RentalProvider
	 * @return {String} Returns "MiningRigRentals"
	 * @static
	 */
	static getType(){
		return "MiningRigRentals"
	}

	/**
	 * Test to make sure the API key and secret are correct
	 * @return {Promise} Returns a Promise that will resolve upon success, and reject on failure
	 */
	async testAuthorization(){
		try {
			let profile = await this.api.whoami();
			return !!(profile.success && profile.data && profile.data.authed);
		} catch (err) {
			throw new Error(err)
		}
	}

	/**
	 * Get MiningRigRentals Profile ID (needed to rent rigs)
	 * @returns {Promise<number>} - the id of the first data object
	 */
	async getProfileID() {
		let profile;
		try {
			profile = await this.api.getPoolProfiles();
		} catch (err) {
			throw new Error(`error getting profile data: ${err}`)
		}
		if (profile.data) {
			//ToDo: be able to pick a pool profile to use
			return Number(profile.data[0].id)
		}
	}
	/**
	 * Get the rigs needed to fulfill rental requirements
	 * @param {number} hashrate - in megahertz(mh)
	 * @param {number} duration - in hours
	 * @returns {Promise<Array.<Object>>}
	 */
	async getRigsToRent(hashrate, duration) {
		//get profileID
		let profileID
		try {
			profileID =  await this.getProfileID()
		} catch (err) {
			throw new Error(`Could not fetch profile ID \n ${err}`)
		}

		let rigOpts = {
			type: 'scrypt',
			minhours: {
				max: duration
			}
		}
		let rigsRequest;
		try {
			rigsRequest = await this.api.getRigs(rigOpts)
		} catch (err) {
			throw new Error(`Could not fetch rig list \n ${err}`)
		}
		let available_rigs = [];
		if (rigsRequest.success && rigsRequest.data) {
			if (rigsRequest.data.records.length === 0) {
				throw new Error(`No rigs found`)
			}
			let newRPIrigs = [], allOtherRigs = [];
			for (let rig of rigsRequest.data.records) {
				if (rig.rpi === 'new') {
					newRPIrigs.push(rig)
				} else {allOtherRigs.push(rig)}
			}
			allOtherRigs.sort((a,b) => {
				return (b.rpi - a.rpi)
			});
			available_rigs = newRPIrigs.concat(allOtherRigs)
		}

		let rigs_to_rent = [], hashpower = 0;
		for (let rig of available_rigs) {
			if ((hashpower + rig.hashrate.advertised.hash) <= hashrate) {				
				hashpower += rig.hashrate.advertised.hash

				let rig_hashrate = rig.hashrate.advertised.hash

				rigs_to_rent.push({
					rental_info: {
						rig: parseInt(rig.id),
						length: duration,
						profile: parseInt(profileID)
					},
					hashrate: rig.hashrate.advertised.hash,
					btc_price: parseFloat(rig.price.BTC.hour) * duration
				})
			}
		}

		return rigs_to_rent
	}

	/**
	 * Get the confirmed account balance for a specific coin (defaults to BTC)
	 * @param {string} [coin='BTC'] - The coin you wish to get a balance for [BTC, LTC, ETH, DASH]
	 * @returns {Promise<(number|Object)>} - will return an object if success is false ex. {success: false}
	 */
	async getBalance(coin) {
		try {
			let response = await this.api.getAccountBalance()
			if (response.success) {
				if (coin) {
					return Number(response.data[coin.toUpperCase()].confirmed)
				} else {
					return Number(response.data['BTC'].confirmed)
				}
			} else {
				return {success: false}
			}
		} catch (err) {
			throw new Error(`Could not fetch account balance \n ${err}`)
		}
	}
	/**
	 * Get Back balances for all coins, confirmed and unconfirmed
	 * @returns {Promise<Object>}
	 */
	async getBalances() {
		try {
			let response = await this.api.getAccountBalance()
			if (response.success) {
				return response.data
			} else {
				return {success: false}
			}
		}
		 catch (err) {
			throw new Error(`Could not fetch account balance \n ${err}`)
		}
	}

	/**
	 * Rent rigs based on hashrate and time
	 * @param {Object} options
	 * @param {number} options.hashrate - The hashrate in MH
	 * @param {number} options.duration - Duration of rent
	 * @param {Function} [options.confirm] - An async function for confirmation
	 * @param {string} [options.type='scrypt'] - Type of rig (Scrypt, x11, sha256, etc)
	 * @returns {Promise<*>}
	 */
	async rent(options) {
		//check balance
		let balance, hasSufficientBalance = true;
		this.getBalance()
		//get rigs
		let rigs_to_rent = [];
		try {
			rigs_to_rent = await this.getRigsToRent(options.hashrate, options.duration)
		} catch (err) {
			throw new Error(`Failed to fetch rigs to rent \n ${err}`)
		}

		//confirmation
		if (options.confirm) {
			try {
				let btc_total_price = 0
				let total_hashrate = 0

				for (let rig of rigs_to_rent){
					btc_total_price += rig.btc_price
					total_hashrate += rig.hashrate
				}

				let confirmed = await options.confirm({
					btc_total_price,
					total_hashrate,
					rigs: rigs_to_rent
				})

				if (!confirmed) {
					return {
						success: false,
						info: "Rental Cancelled"
					}
				}
			} catch (err) {
				throw new Error(err)
			}
		}

		//rent rigs
		let rentalConfirmation = {};
		
		for (let rig of rigs_to_rent) {
			try {
				let rental = await this.api.createRental(rig.rental_info)
				rentalConfirmation[rig.rental_info.rig] = rental
			} catch (err) {
				rentalConfirmation[rig.rental_info.rig] = `Error renting rig: ${err}`
			}
		}

		let rented_rigs = []
		let spent_btc_amount = 0
		let total_rented_hashrate = 0

		for (let rig in rentalConfirmation){
			if (rentalConfirmation[rig].success){
				rented_rigs.push(rentalConfirmation[rig].data)
				spent_btc_amount += parseFloat(rentalConfirmation[rig].data.price.paid)
				total_rented_hashrate += rentalConfirmation[rig].data.hashrate.advertised.hash
			}
		}

		return {
			success: true,
			rented_rigs,
			btc_total_price: spent_btc_amount,
			total_hashrate: total_rented_hashrate
		}
	}
	/**
	 * Get back a "Serialized" state of the Provider
	 * @return {Object} Returns a JSON object that contains the current rental provider state
	 */
	serialize(){
		return {
			type: "MiningRigRentals",
			api_key: this.api_key,
			api_secret: this.api_secret,
			uid: this.uid
		}
	}
}

export default MRRProvider