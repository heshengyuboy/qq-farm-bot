<script setup lang="ts">
import { storeToRefs } from 'pinia'
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import ActivityHeader from '@/components/activity/ActivityHeader.vue'
import ActivityShell from '@/components/activity/ActivityShell.vue'
import BottomNav, { type ActivityTab } from '@/components/activity/BottomNav.vue'
import ConstellationTab from '@/components/activity/ConstellationTab.vue'
import SolarTermsTab from '@/components/activity/SolarTermsTab.vue'
import QingMeiBrewTab from '@/components/activity/QingMeiBrewTab.vue'
import StarSandExchangeDialog from '@/components/activity/StarSandExchangeDialog.vue'
import StarSandShopTab from '@/components/activity/StarSandShopTab.vue'
import TravelPassTab from '@/components/activity/TravelPassTab.vue'
import { useAccountStore } from '@/stores/account'
import { useActivityCenterStore, type ShopGoodsDto } from '@/stores/activity-center'

const router = useRouter()
const accountStore = useAccountStore()
const activityStore = useActivityCenterStore()
const { currentAccountId } = storeToRefs(accountStore)
const { season, shop, solarTerms, constellation, qingMei, actions, tabBadges, loading, error, actionError, notice, loadedAccountId, serverClockOffset, pendingActions } = storeToRefs(activityStore)
const activeTab = ref<ActivityTab>('travel')
const selectedActivity = ref<'stellar' | 'qingmei' | null>(null)
const selectedShopGoods = ref<ShopGoodsDto | null>(null)
const clockNow = ref(Date.now())
let clockTimer: number | undefined

const currentData = computed(() => activeTab.value === 'shop' ? shop.value : activeTab.value === 'solar' ? solarTerms.value : activeTab.value === 'constellation' ? constellation.value : season.value)
const serverNow = computed(() => clockNow.value + serverClockOffset.value)
const accountDataLoaded = computed(() => !!currentAccountId.value && loadedAccountId.value === String(currentAccountId.value))
function isActivityCurrent(value: { endTime?: number | null } | null) {
  if (!value) return false
  return !value.endTime || value.endTime > serverNow.value
}
const stellarAvailable = computed(() => (
  isActivityCurrent(season.value)
  || isActivityCurrent(shop.value)
  || isActivityCurrent(constellation.value)
  || !!solarTerms.value?.terms.some(term => isActivityCurrent(term))
))
const qingMeiAvailable = computed(() => isActivityCurrent(qingMei.value))
const hasCurrentActivity = computed(() => stellarAvailable.value || qingMeiAvailable.value)
const pageTitle = computed(() => currentData.value?.title || season.value?.title || '—')
const theme = computed(() => activeTab.value === 'solar' ? 'day' : 'night')
const endTime = computed(() => {
  if (activeTab.value === 'shop') return shop.value?.endTime
  if (selectedActivity.value === 'qingmei') return qingMei.value?.endTime
  if (activeTab.value === 'constellation') return constellation.value?.endTime || season.value?.endTime
  if (activeTab.value === 'solar') return season.value?.endTime
  return season.value?.endTime
})
const remaining = computed(() => {
  if (!endTime.value) return ''
  const diff = Math.max(0, endTime.value - serverNow.value)
  if (diff === 0) return '活动已结束'
  const days = Math.floor(diff / 86400000)
  const hours = Math.floor(diff % 86400000 / 3600000)
  const minutes = Math.floor(diff % 3600000 / 60000)
  return days > 0 ? `剩余：${days}天${hours}小时` : `剩余：${hours}小时${minutes}分钟`
})
const balanceVisible = computed(() => activeTab.value === 'travel' || activeTab.value === 'shop')
const constellationBrandImage = computed(() => activeTab.value === 'constellation' ? '/activity-center/stellar/activity-title.png' : undefined)

function accountId() { return String(currentAccountId.value || '') }
function load(force = false) { return force ? activityStore.refresh(accountId()) : activityStore.lazyLoad(accountId()) }
function goBack() {
  if (selectedActivity.value) {
    selectedActivity.value = null
    return
  }
  router.back()
}
function claimPass() { activityStore.claimPass(accountId()) }
function lightConstellation() { activityStore.lightConstellation(accountId()) }
function claimSolar(termId: string) { activityStore.claimSolarTerm(accountId(), termId) }
function claimQingMeiSeed() { activityStore.claimQingMeiDailySeed(accountId()) }
function startQingMei(ingredients: Array<{ uid: string, count: number }>) { activityStore.startQingMeiBrew(accountId(), ingredients) }
function continueQingMei() { activityStore.continueQingMeiBrew(accountId()) }
function settleQingMei() { activityStore.settleQingMeiBrew(accountId()) }
function selectShopGoods(goods: ShopGoodsDto) { selectedShopGoods.value = goods }
function closeExchangeDialog() {
  if (!pendingActions.value.exchange)
    selectedShopGoods.value = null
}
async function exchangeShopGoods(goodsId: string, count: number) {
  const succeeded = await activityStore.exchangeStarSandGoods(accountId(), goodsId, count)
  if (succeeded)
    selectedShopGoods.value = null
}

watch(currentAccountId, () => { selectedShopGoods.value = null; load(true) }, { flush: 'post' })
watch(activeTab, tab => { if (tab !== 'shop' && !pendingActions.value.exchange) selectedShopGoods.value = null })
watch([stellarAvailable, qingMeiAvailable], ([stellarCurrent, qingMeiCurrent]) => {
  if ((selectedActivity.value === 'stellar' && !stellarCurrent) || (selectedActivity.value === 'qingmei' && !qingMeiCurrent))
    selectedActivity.value = null
})
onMounted(() => { load(true); clockTimer = window.setInterval(() => clockNow.value = Date.now(), 1000) })
onUnmounted(() => { if (clockTimer) window.clearInterval(clockTimer) })
</script>

<template>
  <section v-if="!selectedActivity" class="activity-picker">
    <button type="button" class="picker-back" aria-label="返回" @click="goBack">‹</button>
    <header class="picker-heading">
      <span>活动中心</span>
      <h1>{{ accountDataLoaded && !loading && !hasCurrentActivity ? '当前无活动' : '选择活动' }}</h1>
    </header>
    <div v-if="!currentAccountId" class="picker-state">
      <div class="i-carbon-user-avatar" />
      <strong>请先选择账号</strong>
      <span>选择账号后查看当前活动</span>
    </div>
    <div v-else-if="loading && !accountDataLoaded" class="picker-state">
      <div class="activity-spinner picker-spinner" />
      <strong>正在加载活动</strong>
    </div>
    <div v-else-if="error && !hasCurrentActivity" class="picker-state">
      <div class="i-carbon-warning-alt" />
      <strong>活动加载失败</strong>
      <span>{{ error }}</span>
      <button type="button" :disabled="loading" @click="load(true)">重新加载</button>
    </div>
    <div v-else-if="accountDataLoaded && !loading && !hasCurrentActivity" class="picker-state empty-activities">
      <div class="i-carbon-calendar" />
      <strong>当前无活动</strong>
      <span>已开放的活动均已结束</span>
      <button type="button" @click="load(true)">刷新活动</button>
    </div>
    <div v-else class="picker-list" :class="{ single: stellarAvailable !== qingMeiAvailable }">
      <button v-if="stellarAvailable" type="button" class="activity-entry stellar-entry" @click="selectedActivity = 'stellar'">
        <img src="/activity-center/stellar/activity-title.png" alt="千星游记">
        <span>千星游记</span>
        <small>游记、观星、星砂商店与节令奖励</small>
      </button>
      <button v-if="qingMeiAvailable" type="button" class="activity-entry qingmei-entry" @click="selectedActivity = 'qingmei'">
        <img v-if="qingMei?.ingredient.image" :src="qingMei.ingredient.image" alt="青梅">
        <span>{{ qingMei?.name || '青酿换万金' }}</span>
        <small>每日领种，酿青梅换金币</small>
      </button>
    </div>
  </section>

  <ActivityShell v-else-if="selectedActivity === 'stellar'" :theme="theme">
    <div class="activity-center">
      <ActivityHeader :title="pageTitle" :brand-image="constellationBrandImage" :remaining="remaining" :balance="balanceVisible ? (shop?.balanceKnown ? (shop.balance ?? '0') : '--') : undefined" :currency-image="shop?.currency.image" :currency-name="shop?.currency.name" :loading="loading" :show-refresh="activeTab !== 'constellation'" @back="goBack" @refresh="load(true)" />
      <div v-if="!currentAccountId" class="activity-state"><strong>请先选择账号</strong><span>活动数据按当前账号加载</span></div>
      <div v-else-if="loading && !season && !shop && !solarTerms && !constellation" class="activity-state"><div class="activity-spinner" /><strong>正在加载活动</strong></div>
      <template v-else>
        <div v-if="error || actionError || notice" class="activity-message" :class="{ success: notice && !error && !actionError }" role="status"><span>{{ actionError || error || notice }}</span><button v-if="error" type="button" :disabled="loading" @click="load(true)">重试</button></div>
        <main class="activity-content">
          <TravelPassTab v-if="activeTab === 'travel'" :season="season" :enabled="actions.claimPass.enabled" :pending="pendingActions.claimPass" @claim="claimPass" />
          <ConstellationTab v-else-if="activeTab === 'constellation'" :constellation="constellation" :enabled="actions.lightConstellation.enabled" :pending="pendingActions.lightConstellation" @light="lightConstellation" />
          <StarSandShopTab v-else-if="activeTab === 'shop'" :shop="shop" :enabled="actions.exchange.enabled" :pending="pendingActions.exchange" @select="selectShopGoods" />
          <SolarTermsTab v-else :solar="solarTerms" :now="serverNow" :pending="pendingActions.claimSolar" @claim="claimSolar" />
        </main>
      </template>
      <BottomNav v-model="activeTab" :badges="tabBadges" />
      <StarSandExchangeDialog
        :open="!!selectedShopGoods"
        :goods="selectedShopGoods"
        :shop="shop"
        :pending="pendingActions.exchange"
        @close="closeExchangeDialog"
        @confirm="exchangeShopGoods"
      />
    </div>
  </ActivityShell>

  <ActivityShell v-else theme="day">
    <div class="activity-center">
      <ActivityHeader :title="qingMei?.title || '青酿换万金'" :remaining="remaining" :loading="loading" @back="goBack" @refresh="load(true)" />
      <div v-if="!currentAccountId" class="activity-state qingmei-state"><strong>请先选择账号</strong><span>活动数据按当前账号加载</span></div>
      <div v-else-if="loading && !qingMei" class="activity-state qingmei-state"><div class="activity-spinner" /><strong>正在加载青酿活动</strong></div>
      <template v-else>
        <div v-if="error || actionError || notice" class="activity-message" :class="{ success: notice && !error && !actionError }" role="status"><span>{{ actionError || error || notice }}</span><button v-if="error" type="button" :disabled="loading" @click="load(true)">重试</button></div>
        <main class="activity-content qingmei-content">
          <QingMeiBrewTab :activity="qingMei" :pending-seed="pendingActions.claimQingMeiSeed" :pending-start="pendingActions.startQingMeiBrew" :pending-continue="pendingActions.continueQingMeiBrew" :pending-sell="pendingActions.settleQingMeiBrew" @claim-seed="claimQingMeiSeed" @start="startQingMei" @continue="continueQingMei" @settle="settleQingMei" />
        </main>
      </template>
    </div>
  </ActivityShell>
</template>

<style scoped>
.activity-picker{position:fixed;z-index:50;inset:0;overflow:auto;padding:clamp(72px,12vh,116px) 18px 34px;color:#173b31;background:#e8f2e8}.picker-back{position:absolute;top:18px;left:18px;width:40px;height:40px;border:1px solid #aec7b8;border-radius:50%;color:#315d4c;background:#fff;font-size:30px;line-height:1;cursor:pointer}.picker-heading{width:min(760px,100%);margin:0 auto 22px}.picker-heading span{color:#6e8579;font-size:12px;font-weight:700}.picker-heading h1{margin:3px 0 0;font-size:32px;letter-spacing:0}.picker-list{width:min(760px,100%);display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px;margin:0 auto}.picker-list.single{grid-template-columns:minmax(0,373px)}.picker-state{width:min(760px,100%);min-height:300px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;margin:0 auto;padding:30px;color:#587165;text-align:center}.picker-state>div{font-size:38px}.picker-state strong{font-size:18px}.picker-state span{max-width:420px;color:#72877d;font-size:12px}.picker-state button{height:36px;margin-top:8px;padding:0 15px;border:1px solid #9eb9aa;border-radius:6px;color:#315d4c;background:white;font-weight:700;cursor:pointer}.picker-state button:disabled{opacity:.55;cursor:wait}.picker-state .picker-spinner{width:42px;height:42px;border-color:rgba(49,93,76,.2);border-top-color:#315d4c;font-size:0}.empty-activities>div{color:#71897d}.activity-entry{position:relative;min-height:260px;display:flex;overflow:hidden;flex-direction:column;align-items:flex-start;justify-content:flex-end;padding:20px;border:1px solid rgba(25,73,53,.18);border-radius:8px;color:#fff;text-align:left;box-shadow:0 8px 24px rgba(34,68,48,.14);cursor:pointer}.activity-entry::after{content:'';position:absolute;inset:35% 0 0;background:linear-gradient(transparent,rgba(7,40,29,.88))}.activity-entry img{position:absolute;inset:20px 18px auto;width:calc(100% - 36px);height:145px;object-fit:contain}.activity-entry span,.activity-entry small{position:relative;z-index:1}.activity-entry span{font-size:21px;font-weight:800}.activity-entry small{margin-top:3px;color:rgba(255,255,255,.82);font-size:11px}.stellar-entry{background:#185d8d url('/activity-center/stellar/night-background.png') center/cover}.qingmei-entry{background:linear-gradient(145deg,#76ad6c,#d9cb79)}.qingmei-entry img{inset:24px auto auto 50%;width:145px;transform:translateX(-50%)}
.activity-center{position:relative;height:100%;min-height:0;overflow:hidden}.activity-content{position:absolute;inset:0;overflow-x:hidden;overflow-y:auto;overscroll-behavior:contain;scrollbar-width:thin;scrollbar-color:rgba(172,224,246,.5) transparent}.activity-message{position:absolute;z-index:25;top:calc(91px + env(safe-area-inset-top));left:12px;right:12px;min-height:30px;display:flex;align-items:center;justify-content:space-between;gap:8px;padding:5px 10px;border:1px solid rgba(255,220,142,.6);border-radius:10px;color:#fff0c2;background:rgba(88,51,28,.86);font-size:10px}.activity-message.success{border-color:rgba(179,242,202,.65);color:#e5ffed;background:rgba(30,91,67,.83)}.activity-message button{flex:none;padding:3px 8px;border:1px solid rgba(255,255,255,.42);border-radius:8px;color:white;background:rgba(255,255,255,.12);cursor:pointer}.activity-state{position:absolute;z-index:5;inset:0 0 92px;display:flex;flex-direction:column;align-items:center;justify-content:center;color:#c9e7f7;text-align:center}.activity-state strong{margin-top:12px;font-size:16px}.activity-state span{margin-top:4px;color:#9ec7dc;font-size:11px}.activity-spinner{width:43px;height:43px;border:3px solid rgba(180,232,250,.25);border-top-color:#dff9ff;border-radius:50%;animation:spin .85s linear infinite}@keyframes spin{to{transform:rotate(360deg)}}
.qingmei-content{bottom:0}.qingmei-state{inset:0;color:#315d4c}.qingmei-state span{color:#668375}@media(max-width:620px){.activity-picker{padding-top:76px}.picker-list{grid-template-columns:1fr}.activity-entry{min-height:220px}.activity-entry img{height:120px}}
</style>
