. /data/adb/adblockpro/scripts/compat.sh || exit 1

# most of the users are Chinese, so set default language to Chinese
language="zh"

# try to get the system language
locale=$(getprop persist.sys.locale || getprop ro.product.locale || getprop persist.sys.language)

# if the system language is English, set language to English
if echo "$locale" | grep -qi "en"; then
  language="en"
fi

function log() {
  local timestamp=$(date "+%Y-%m-%d %H:%M:%S")
  local str
  [ "$language" = "en" ] && str="$timestamp $1" || str="$timestamp $2"
  echo "$str" | tee -a "$AGH_DIR/history.log"
}

function update_description() {
  local description
  [ "$language" = "en" ] && description="$1" || description="$2"
  local module_id
  module_id=$(grep "^id=" "$MOD_PATH/module.prop" | cut -d'=' -f2)
  # Only use the selected root family's API; stale manager files may remain.
  case "$(abp_root_family)" in
    KernelSU)
      if [ -x /data/adb/ksud ]; then
        MODULE_ID="$module_id" /data/adb/ksud module config set override.description "$description" && return 0
      fi ;;
    APatch)
      if [ -x /data/adb/apd ]; then
        MODULE_ID="$module_id" /data/adb/apd module config set override.description "$description" && return 0
      fi ;;
  esac
  sed -i "/^description=/c\description=$description" "$MOD_PATH/module.prop"
}
